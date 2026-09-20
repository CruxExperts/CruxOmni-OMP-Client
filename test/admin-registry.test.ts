import { expect, test } from "bun:test";
import {
  getOperation,
  listCategories,
  listOperations,
  operationRegistry,
  projectResponse,
  validateOperation,
} from "../src/admin/registry.ts";

test("closed inventory exposes every invokable descriptor and stable categories", () => {
  expect(operationRegistry.size).toBe(1_130);
  expect(listOperations()).toHaveLength(1_130);
  expect(new Set(listOperations().map((item) => item.descriptor.operationId)).size).toBe(1_130);
  expect(listCategories().length).toBeGreaterThan(1);
  expect(getOperation("GET /api/providers")?.coverage.status).toBe("invokable");
  expect(getOperation("POST /api/openapi/try")?.coverage.status).toBe("non-invokable");
});

test("operation input validators reject unknown top-level fields and bodies", () => {
  expect(() => validateOperation("GET /api/providers", { unexpected: true })).toThrow();
  expect(() => validateOperation("GET /api/providers", { body: {} })).toThrow();
  expect(validateOperation("GET /api/providers", {})).toEqual({ path: {}, query: {} });
});

test("response projections withhold unknown and secret-bearing fields", () => {
  const descriptor = getOperation("GET /api/providers");
  if (!descriptor) throw new Error("provider operation missing from closed inventory");
  expect(projectResponse(descriptor, { unknown: "not-for-agents", apiKey: "secret" })).toEqual({});
});

test("unknown and non-invokable operation IDs fail closed", () => {
  expect(() => operationRegistry.require("GET /not-in-inventory")).toThrow();
  expect(() => operationRegistry.require("POST /api/openapi/try")).toThrow();
});

test("release eligibility is default-deny and binds verified records to exact source evidence", () => {
  expect(operationRegistry.getEligibility("DELETE /api/cache")).toMatchObject({ status: "unavailable" });
  expect(operationRegistry.getEligibility("GET /not-in-inventory")).toMatchObject({ status: "unavailable" });
  expect(operationRegistry.lookup("GET /api/health")?.eligibility.status).toBe("verified");
  expect(operationRegistry.lookup("GET /api/health")?.eligibility.source?.sha256).toBe(getOperation("GET /api/health")?.source.sha256);
  expect(operationRegistry.project("GET /api/health", { status: "ok", timestamp: "2026-09-20T18:00:00.000Z", secret: "withheld" })).toEqual({ status: "ok", timestamp: "2026-09-20T18:00:00.000Z" });
  expect(() => operationRegistry.project("GET /api/health", { status: "not-ok", timestamp: "2026-09-20T18:00:00.000Z" })).toThrow();
});
