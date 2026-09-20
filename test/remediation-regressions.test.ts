import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import registerOmniRouteProvider from "../src/index.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { commitPendingConfig, savePendingConfig, setAgentDirResolverForTests } from "../src/config.ts";
import { createBoundInferenceStream, createSingleDispatchFetch, OMNIROUTE_GUARDED_API } from "../src/inference.ts";
import { OperationRegistry, operationRegistry } from "../src/admin/registry.ts";
import { invokeBinaryAdapter, invokeJsonAdapter, invokeMultipartAdapter, invokeSseAdapter, invokeWebSocketAdapter } from "../src/admin/adapters.ts";

const savedEnvironment = { ...process.env };
let temporaryRoot: string | undefined;

afterEach(async () => {
  process.env = { ...savedEnvironment };
  setAgentDirResolverForTests(undefined);
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

async function isolatedProfile(): Promise<string> {
  temporaryRoot = await mkdtemp(join(tmpdir(), "omp-omniroute-regression-"));
  setAgentDirResolverForTests(() => temporaryRoot!);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("OMP_OMNIROUTE_")) delete process.env[name];
  }
  return temporaryRoot;
}

function capturedExtension() {
  const providers: Array<{ name: string; config: Record<string, unknown> }> = [];
  const events = new Map<string, (...args: any[]) => unknown>();
  let unregisters = 0;
  const pi = {
    zod: z,
    registerProvider(name: string, config: Record<string, unknown>) { providers.push({ name, config }); },
    unregisterProvider() { unregisters += 1; },
    registerCommand() {},
    registerTool() {},
    on(name: string, handler: (...args: any[]) => unknown) { events.set(name, handler); },
  };
  return { pi, providers, events, unregisters: () => unregisters };
}

test("pending native replacement never registers the old active endpoint", async () => {
  await isolatedProfile();
  const oldPending = await savePendingConfig("https://old.example");
  const active = await commitPendingConfig(oldPending.pending, oldPending.revision === undefined ? undefined : { expectedRevision: oldPending.revision });
  await savePendingConfig({ ...active, pending: { endpoint: "https://new.example", generation: 2, status: "validated" } }, active.revision === undefined ? undefined : { expectedRevision: active.revision });
  const extension = capturedExtension();
  await registerOmniRouteProvider(extension.pi as never);
  const initial = extension.providers.at(-1)?.config;
  expect(initial?.baseUrl).toBeUndefined();
  expect(initial?.fetchDynamicModels).toBeUndefined();
});

test("authoritative empty discovery unregisters source-owned provider state", async () => {
  await isolatedProfile();
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ data: [] }) });
  try {
    process.env.OMP_OMNIROUTE_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.OMP_OMNIROUTE_API_KEY = "fixture-runtime-key";
    const extension = capturedExtension();
    await registerOmniRouteProvider(extension.pi as never);
    const sessionStart = extension.events.get("session_start");
    if (!sessionStart) throw new Error("session_start handler was not registered");
    await sessionStart({}, { hasUI: false, modelRegistry: {}, ui: { notify() {} } });
    expect(extension.unregisters()).toBeGreaterThan(0);
    expect(extension.providers.at(-1)?.config.models).toEqual([]);
  } finally {
    server.stop();
  }
});

function adminHarness(readTarget: () => Promise<string> = async () => "target") {
  let dispatches = 0;
  const descriptor = operationRegistry.getOperation("DELETE /api/cache");
  if (!descriptor) throw new Error("mutation fixture descriptor missing");
  const executor = createAdminExecutor({
    registry: new OperationRegistry([descriptor], { records: [{ operationId: descriptor.operationId, status: "verified", reason: "explicit synthetic fixture eligibility", source: descriptor.source, evidence: [{ kind: "fixture", detail: "synthetic dispatch only" }] }] }),
    readTarget,
    dispatch: async () => { dispatches += 1; return { ok: true }; },
  });
  executor.bindCredential({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", apiKey: "fixture-management-key" });
  return { executor, dispatches: () => dispatches };
}

test("read rejects a mutation even when a caller claims confirmation", async () => {
  const harness = adminHarness();
  await expect(harness.executor.read("DELETE /api/cache", { body: {} }, { confirmed: true })).rejects.toMatchObject({ code: "confirmation-required" });
  expect(harness.dispatches()).toBe(0);
});

test("missing eligibility evidence rejects an otherwise schema-valid read before dispatch", async () => {
  let dispatches = 0;
  const executor = createAdminExecutor({ dispatch: async () => { dispatches += 1; return {}; } });
  executor.bindCredential({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", apiKey: "fixture-management-key" });
  await expect(executor.read("GET /api/cache", {})).rejects.toMatchObject({ code: "operation-unavailable" });
  expect(dispatches).toBe(0);
});

test("barrier-synchronized concurrent applies dispatch exactly once", async () => {
  let release!: () => void;
  let reads = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const harness = adminHarness(async () => {
    reads += 1;
    if (reads > 1) await barrier;
    return "target";
  });
  const plan = await harness.executor.plan("DELETE /api/cache", { body: {} });
  const first = harness.executor.apply(plan.planId, { confirmed: true });
  const second = harness.executor.apply(plan.planId, { confirmed: true });
  release();
  const settled = await Promise.allSettled([first, second]);
  expect(settled.filter(item => item.status === "fulfilled")).toHaveLength(1);
  expect(harness.dispatches()).toBe(1);
});

test("unchanged credential rebinding preserves a pending plan", async () => {
  const harness = adminHarness();
  const plan = await harness.executor.plan("DELETE /api/cache", { body: {} });
  const before = harness.executor.getCredentialBinding();
  const after = harness.executor.bindCredential({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", apiKey: "fixture-management-key" });
  expect(after.credentialGeneration).toBe(before!.credentialGeneration);
  expect(harness.executor.getPlan(plan.planId)?.state).toBe("pending");
});

test("public descriptors still require an enabled management binding", async () => {
  let dispatches = 0;
  const executor = createAdminExecutor({ dispatch: async () => { dispatches += 1; return {}; } });
  executor.bindCredential({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", apiKey: "fixture-management-key" });
  executor.disable();
  await expect(executor.read("GET /api/health", {})).rejects.toMatchObject({ code: "credential-disabled" });
  expect(dispatches).toBe(0);
});

test("logout blocks automatic credential rebinding until explicit human enable", () => {
  const harness = adminHarness();
  harness.executor.logout();
  expect(() => harness.executor.bindCredential({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", apiKey: "fixture-management-key" })).toThrow();
  harness.executor.setAdminBinding({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", credentialGeneration: 2 }, true);
  expect(harness.executor.bindCredential({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", apiKey: "fixture-management-key" }).enabled).toBe(true);
});

test("inference fetch rejects redirects and a second network dispatch", async () => {
  let calls = 0;
  const baseFetch: typeof fetch = Object.assign(async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "https://other.example/v1/responses" } });
  }, { preconnect: globalThis.fetch.preconnect });
  const guarded = createSingleDispatchFetch("https://gateway.example", baseFetch);
  await expect(guarded("https://gateway.example/v1/responses", { method: "POST" })).rejects.toMatchObject({ code: "inference-redirect" });
  await expect(guarded("https://gateway.example/v1/responses", { method: "POST" })).rejects.toMatchObject({ code: "inference-replay-suppressed" });
  expect(calls).toBe(1);
});

test("cached or superseded models fail before inference I/O", () => {
  let binding = { endpoint: "https://gateway.example", credential: "fixture-runtime-key", generation: 2 };
  const stream = createBoundInferenceStream({
    expectedEndpoint: binding.endpoint,
    expectedGeneration: binding.generation,
    modelApis: new Map([["live-model", "openai-responses"]]),
    currentBinding: () => binding,
    stopped: () => false,
  });
  binding = { ...binding, generation: 3 };
  expect(() => stream({ id: "live-model", api: OMNIROUTE_GUARDED_API } as never, { messages: [], tools: [] } as never)).toThrow();
});

test("disablement while final target observation is pending prevents dispatch", async () => {
  let release!: () => void;
  let reads = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const harness = adminHarness(async () => {
    reads += 1;
    if (reads > 1) await barrier;
    return "target";
  });
  const plan = await harness.executor.plan("DELETE /api/cache", { body: {} });
  const applying = harness.executor.apply(plan.planId, { confirmed: true });
  harness.executor.disable();
  release();
  await expect(applying).rejects.toMatchObject({ code: "plan-invalidated" });
  expect(harness.dispatches()).toBe(0);
});

test("complete approval previews reject unseen long suffixes", async () => {
  const base = operationRegistry.getOperation("DELETE /api/cache");
  if (!base) throw new Error("fixture descriptor missing");
  const descriptor = {
    ...base,
    operationId: "POST /fixture/preview",
    method: "POST" as const,
    pathTemplate: "/fixture/preview",
    request: {
      ...base.request,
      body: { required: true, mediaType: "application/json", schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false } },
    },
  };
  const executor = createAdminExecutor({ registry: new OperationRegistry([descriptor], { records: [{ operationId: descriptor.operationId, status: "verified", reason: "explicit synthetic fixture eligibility", source: descriptor.source, evidence: [{ kind: "fixture", detail: "synthetic dispatch only" }] }] }), readTarget: async () => "target", dispatch: async () => ({ ok: true }) });
  executor.bindCredential({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", apiKey: "fixture-management-key" });
  await expect(executor.plan(descriptor.operationId, { body: { note: `visible${"x".repeat(8_100)}hidden-suffix` } })).rejects.toMatchObject({ code: "preview-too-large" });
});

test("registry and every dispatch adapter reject traversal or a tampered resolved path", async () => {
  const adapter = operationRegistry.lookup("DELETE /api/keys/{id}");
  if (!adapter) throw new Error("path fixture descriptor missing");
  for (const id of [".", "..", "%2e%2e", "%252e%252e", "%2f", "%5c"]) {
    expect(() => adapter.buildPath(adapter.validate({ path: { id }, body: {} }))).toThrow();
  }
  expect(adapter.buildPath(adapter.validate({ path: { id: "模型" }, body: {} }))).toContain("%E6%A8%A1%E5%9E%8B");
  const invocation = { descriptor: { ...adapter.descriptor, adapterId: adapter.adapterId }, endpoint: "http://127.0.0.1:20128", credential: { kind: "apiKey" as const, value: "fixture-management-key" }, resolvedPath: "/api/cache", body: {} };
  await expect(invokeJsonAdapter(invocation)).rejects.toMatchObject({ code: "invalid_path" });
  await expect(invokeSseAdapter(invocation)).rejects.toMatchObject({ code: "invalid_path" });
  await expect(invokeBinaryAdapter(invocation)).rejects.toMatchObject({ code: "invalid_path" });
  await expect(invokeMultipartAdapter(invocation, [], {})).rejects.toMatchObject({ code: "invalid_path" });
  let opened = false;
  await expect(invokeWebSocketAdapter(invocation, () => { opened = true; throw new Error("must not open"); })).rejects.toMatchObject({ code: "invalid_path" });
  expect(opened).toBe(false);
});

test("operator-required dispatch is terminal and is never reported as applied", async () => {
  const descriptor = operationRegistry.getOperation("DELETE /api/cache");
  if (!descriptor) throw new Error("mutation fixture descriptor missing");
  const executor = createAdminExecutor({
    registry: new OperationRegistry([descriptor], { records: [{ operationId: descriptor.operationId, status: "verified", reason: "explicit synthetic fixture eligibility", source: descriptor.source, evidence: [{ kind: "fixture", detail: "synthetic dispatch only" }] }] }),
    readTarget: async () => "target",
    dispatch: async () => ({ status: "operator-required", reason: "external-consent", message: "operator action required" }),
  });
  executor.bindCredential({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", apiKey: "fixture-management-key" });
  const plan = await executor.plan("DELETE /api/cache", { body: {} });
  const result = await executor.apply(plan.planId, { confirmed: true });
  expect(result.status).toBe("operator-required");
  expect(executor.getPlan(plan.planId)?.state).toBe("operator-required");
  await expect(executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-already-applied" });
});
