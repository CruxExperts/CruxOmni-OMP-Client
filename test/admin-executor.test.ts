import { expect, test } from "bun:test";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { OperationRegistry, operationRegistry } from "../src/admin/registry.ts";

const MUTATION = "DELETE /api/cache";
const MUTATION_INPUT = { body: {} };

function setup(options: { now?: () => number; dispatch?: (request: unknown, context: unknown) => Promise<unknown>; readTarget?: () => Promise<string>; reconcile?: () => Promise<unknown> } = {}) {
  let calls = 0;
  const executor = createAdminExecutor({
    ...(options.now === undefined ? {} : { now: options.now }),
    readTarget: options.readTarget ?? (async () => "target-a"),
    dispatch: options.dispatch ?? (async () => { calls += 1; return { ok: true, unknown: "withheld" }; }),
    registry: new OperationRegistry([operationRegistry.getOperation(MUTATION)!], { records: [{
      operationId: MUTATION,
      status: "verified",
      reason: "explicit synthetic fixture eligibility",
      source: operationRegistry.getOperation(MUTATION)!.source,
      evidence: [{ kind: "fixture", detail: "synthetic dispatch only" }],
    }] }),
    ...(options.reconcile === undefined ? {} : { reconcile: options.reconcile }),
  });
  executor.bindCredential({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", apiKey: "management-secret" });
  return { executor, calls: () => calls };
}

test("denied and headless applies perform zero dispatches", async () => {
  const denied = setup();
  const plan = await denied.executor.plan(MUTATION, MUTATION_INPUT);
  const result = await denied.executor.apply(plan.planId, { confirmed: false });
  expect(result.status).toBe("denied");
  expect(denied.calls()).toBe(0);

  const headless = setup();
  const headlessPlan = await headless.executor.plan(MUTATION, MUTATION_INPUT);
  const headlessResult = await headless.executor.apply(headlessPlan.planId, { confirmed: true, headless: true });
  expect(headlessResult.status).toBe("denied");
  expect(headless.calls()).toBe(0);
});

test("expired plans are rejected before dispatch", async () => {
  let clock = 0;
  const configured = setup({ now: () => clock });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  clock = plan.expiresAt;
  await expect(configured.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-expired" });
  expect(configured.calls()).toBe(0);
});

test("target drift and credential changes invalidate a plan", async () => {
  let target = "target-a";
  const configured = setup({ readTarget: async () => target });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  target = "target-b";
  await expect(configured.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "target-drift" });
  expect(configured.calls()).toBe(0);

  const changed = setup();
  const changedPlan = await changed.executor.plan(MUTATION, MUTATION_INPUT);
  changed.executor.bindCredential({ profileId: "omniroute", endpoint: "http://127.0.0.1:20129", apiKey: "new-secret" });
  await expect(changed.executor.apply(changedPlan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-invalidated" });
});

test("duplicate applies never replay a write", async () => {
  const configured = setup();
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  expect((await configured.executor.apply(plan.planId, { confirmed: true })).status).toBe("applied");
  await expect(configured.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-already-applied" });
  expect(configured.calls()).toBe(1);
});

test("lost responses reconcile once and remain unknown", async () => {
  let dispatchCalls = 0;
  let reconcileCalls = 0;
  const configured = setup({
    dispatch: async () => { dispatchCalls += 1; throw Object.assign(new Error("remote secret detail"), { uncertain: true }); },
    reconcile: async () => { reconcileCalls += 1; throw new Error("reconcile unavailable"); },
  });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  const result = await configured.executor.apply(plan.planId, { confirmed: true });
  expect(result.status).toBe("unknown");
  expect(dispatchCalls).toBe(1);
  expect(reconcileCalls).toBe(1);
  await expect(configured.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-already-applied" });
});

test("plans expose no credential values and errors are stable redacted records", async () => {
  const configured = setup({ dispatch: async () => { throw Object.assign(new Error("apiKey=management-secret"), { status: 500 }); } });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  expect(JSON.stringify(plan)).not.toContain("management-secret");
  await expect(configured.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "dispatch-failed", status: 500 });
});
