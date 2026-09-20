import { unlink } from "node:fs/promises";
import { expect, test } from "bun:test";
import { ADMIN_ADAPTER_LIMITS, adapterFor, invokeJsonAdapter, invokeMultipartAdapter, invokeWebSocketAdapter, isLoopbackHostname, validateAdminEndpoint, writeProtectedFile } from "../src/admin/adapters.ts";
import { getOperation, OperationRegistry, projectResponse } from "../src/admin/registry.ts";
import { registerAdminCommand } from "../src/admin/ui.ts";
import type { AdminPlanHandle } from "../src/admin/types.ts";

const jsonDescriptor = {
  operationId: "GET /api/models",
  adapterId: "typed.get.api.models",
  method: "GET" as const,
  pathTemplate: "/api/models",
  mediaType: { request: "application/json", response: "application/json" },
  streaming: { mode: "json" as const, framing: "json" },
  auth: { domain: "management", scopes: [] },
};

test("loopback validation is explicit and rejects endpoint credentials", () => {
  expect(isLoopbackHostname("127.0.0.1")).toBe(true);
  expect(isLoopbackHostname("remote.example")).toBe(false);
  expect(isLoopbackHostname("127.evil.example")).toBe(false);
  expect(() => validateAdminEndpoint("https://user:pass@remote.example")).toThrow();
  expect(() => validateAdminEndpoint("https://remote.example", true)).toThrow();
  expect(validateAdminEndpoint("http://127.0.0.1:20128", true).hostname).toBe("127.0.0.1");
});

test("WebSocket handshake carries the bound credential in headers", async () => {
  let headers: Record<string, string> | undefined;
  const socket = {
    onopen: null as (() => void) | null,
    onmessage: null,
    onerror: null,
    onclose: null as ((event: { code: number }) => void) | null,
    send() {},
    close() {},
  };
  const result = invokeWebSocketAdapter({
    descriptor: { ...jsonDescriptor, streaming: { mode: "websocket" as const, framing: "message" } },
    endpoint: "http://127.0.0.1:20128",
    credential: { kind: "apiKey", value: "fixture-management-key" },
  }, (_url, options) => {
    headers = options.headers;
    queueMicrotask(() => { socket.onopen?.(); socket.onclose?.({ code: 1000 }); });
    return socket as unknown as WebSocket;
  });
  await expect(result).resolves.toMatchObject({ status: 200 });
  expect(headers?.authorization).toBe("Bearer fixture-management-key");
});

test("operation protocol selection remains dedicated", () => {
  expect(adapterFor(jsonDescriptor)).toBe("json");
  expect(adapterFor({ ...jsonDescriptor, streaming: { mode: "sse", framing: "event-stream" } })).toBe("sse");
  expect(adapterFor({ ...jsonDescriptor, streaming: { mode: "binary", framing: "bytes" } })).toBe("binary");
  expect(adapterFor({ ...jsonDescriptor, mediaType: { request: "application/json", response: "application/octet-stream" } })).toBe("binary");
  expect(adapterFor({ ...jsonDescriptor, pathTemplate: "/api/oauth/login" })).toBe("operator-required");
});

test("apply command stays human-only when form is cancelled", async () => {
  let applyCalls = 0;
  let command: { handler: (args: string, context: unknown) => Promise<void> } | undefined;
  const cancelledPlan: AdminPlanHandle = {
    planId: "p-missing",
    operationId: "GET /api/models",
    profileId: "omniroute",
    endpoint: "http://127.0.0.1:20128",
    credentialGeneration: 1,
    payloadDigest: "payload-digest",
    targetDigest: "target-digest",
    risk: "read" as const,
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    state: "pending" as const,
    preview: {
      operationId: "GET /api/models",
      method: "GET" as const,
      pathTemplate: "/api/models",
      target: { profileId: "omniroute", endpoint: "http://127.0.0.1:20128" },
      risk: "read" as const,
      confirmationRequired: true,
      sideEffect: "read" as const,
      payload: { path: {}, query: {} },
      consequence: "No state changes are expected.",
      resolvedPath: "/api/models",
      query: {},
      planDigest: "plan-digest",
    },
  };
  const executor = {
    apply: async () => { applyCalls++; return { status: "applied" as const }; },
    getCredentialBinding: () => ({
      profileId: "omniroute",
      endpoint: "http://127.0.0.1:20128",
      credentialGeneration: 1,
      scopes: [],
      enabled: true,
    }),
    getPlan: (planId: string) => planId === cancelledPlan.planId ? cancelledPlan : undefined,
    logout: () => undefined,
    disable: () => undefined,
  };
  const pi = {
    registerCommand(_name: string, value: { handler: (args: string, context: unknown) => Promise<void> }) { command = value; },
  };
  registerAdminCommand(pi as never, { executor: executor as never, endpoint: "http://127.0.0.1:20128" });
  const context = {
    hasUI: true,
    ui: {
      custom: async () => undefined,
      confirm: async () => true,
      notify: () => undefined,
    },
  };
  await command?.handler("apply p-missing", context);
  expect(applyCalls).toBe(0);
});

test("protected export refuses an existing destination", async () => {
  const path = `/tmp/omp-omniroute-admin-ui-${process.pid}`;
  await Bun.write(path, "existing");
  await expect(writeProtectedFile(path, new Uint8Array([1]))).rejects.toThrow();
  await unlink(path);
});

test("fresh enablement confirms the exact endpoint before persisting or binding", async () => {
  let command: { handler: (args: string, context: unknown) => Promise<void> } | undefined;
  let enabledEndpoint: string | undefined;
  let confirms = 0;
  const pi = {
    registerCommand(_name: string, value: { handler: (args: string, context: unknown) => Promise<void> }) { command = value; },
  };
  const executor = { getCredentialBinding: () => undefined, logout: () => undefined, disable: () => undefined };
  registerAdminCommand(pi as never, {
    executor: executor as never,
    resolveEffectiveEndpoint: async () => undefined,
    onEnable: async endpoint => {
      enabledEndpoint = endpoint;
      return { endpoint, credentialGeneration: 1 };
    },
  });
  const context = {
    hasUI: true,
    ui: {
      custom: async () => "http://127.0.0.1:20128",
      confirm: async (_title: string, detail: string) => {
        confirms += 1;
        expect(detail).toContain("http://127.0.0.1:20128");
        return true;
      },
      notify: () => undefined,
    },
  };
  await command?.handler("enable", context);
  expect(confirms).toBe(1);
  expect(enabledEndpoint).toBe("http://127.0.0.1:20128");
});

test("multipart dispatch turns dedicated file entries into blobs, never path fields", async () => {
  const path = `/tmp/omp-omniroute-admin-multipart-${process.pid}`;
  await Bun.write(path, "payload");
  const originalFetch = globalThis.fetch;
  let form: FormData | undefined;
  try {
    const mockFetch: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        form = init?.body as FormData;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      },
      { preconnect: originalFetch.preconnect },
    );
    globalThis.fetch = mockFetch;
    await invokeMultipartAdapter({
      descriptor: { ...jsonDescriptor, mediaType: { request: "multipart/form-data", response: "application/json" } },
      endpoint: "http://127.0.0.1:20128",
      body: { files: [{ field: "archive", path }], fields: { note: "hello" } },
    }, [{ field: "archive", path }], { note: "hello" });
    expect(form?.get("note")).toBe("hello");
    expect(form?.get("archive")).toBeInstanceOf(Blob);
    expect(form?.get("path")).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    await unlink(path);
  }
});

test("local schema refs constrain validation and projection while external refs fail closed", () => {
  const descriptor = getOperation("GET /api/agent-skills/coverage");
  if (!descriptor) throw new Error("reference descriptor missing");
  const local = {
    ...descriptor,
    request: { ...descriptor.request, pathSchema: { $ref: "#/$defs/methodCounts" } },
    response: { ...descriptor.response, schema: { $ref: "#/$defs/release" } },
  };
  const registry = new OperationRegistry([local]);
  expect(() => registry.validateOperation(local.operationId, {})).toThrow();
  expect(registry.project(local.operationId, { repository: "safe", unknown: "withheld" })).toEqual({ repository: "safe" });
  expect(() => projectResponse({ ...descriptor, response: { ...descriptor.response, schema: { $ref: "https://example.invalid/schema" } } }, {})).toThrow();
});

test("stalled response bodies are cancelled by the combined deadline", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = ADMIN_ADAPTER_LIMITS.timeoutMs;
  let cancelled = false;
  (ADMIN_ADAPTER_LIMITS as unknown as { timeoutMs: number }).timeoutMs = 10;
  try {
    const mockFetch: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0]) => new Response(new ReadableStream<Uint8Array>({
        start() { /* intentionally leaves the reader pending */ },
        cancel() { cancelled = true; },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      { preconnect: originalFetch.preconnect },
    );
    globalThis.fetch = mockFetch;
    await expect(invokeJsonAdapter({ descriptor: jsonDescriptor, endpoint: "http://127.0.0.1:20128" })).rejects.toMatchObject({ code: "timeout" });
    expect(cancelled).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    (ADMIN_ADAPTER_LIMITS as unknown as { timeoutMs: number }).timeoutMs = originalTimeout;
  }
});
