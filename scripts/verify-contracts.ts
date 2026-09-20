import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, generateContracts, normalizeNextRoutePath, sha256 } from "./generate-contracts.ts";

type AnyRecord = Record<string, unknown>;
const packageRoot = resolve(import.meta.dir, "..");
const manifestPath = resolve(packageRoot, "provenance/route-sources.json");
const operationsPath = resolve(packageRoot, "contracts/operations.json");
const eligibilityPath = resolve(packageRoot, "contracts/release-eligibility.json");
const METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"] as const;
const ALLOWED_NON_INVOKABLE = [
  "Unknown /api catch-all",
  "OpenAPI try endpoint",
  "Documentation search framework plumbing",
  "True duplicate alias",
];

function readJson(path: string): AnyRecord {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed as AnyRecord;
}

function requireObject(value: unknown, label: string): AnyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as AnyRecord;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function verifyRelease(manifest: AnyRecord, operations: AnyRecord): void {
  const release = requireObject(manifest.release, "manifest.release");
  const operationRelease = requireObject(operations.release, "operations.release");
  const expected = { repository: "diegosouzapw/OmniRoute", tag: "v3.8.50", commit: "5458026c216f77a3da68ea49152dc33470cfe2cb" };
  for (const [key, value] of Object.entries(expected)) {
    if (release[key] !== value || operationRelease[key] !== value) throw new Error(`release selector drift: ${key}`);
  }
  if (release.selectorKind !== "github-latest-release" || release.latestRedirectTarget !== "v3.8.50" || release.readmeNpmBadgeIsNotSelector !== true) throw new Error("latest-release provenance selector is incomplete");
}

function verifyManifest(manifest: AnyRecord): Map<string, AnyRecord> {
  if (manifest.schemaVersion !== 1 || manifest.recordKind !== "omniroute-route-source-manifest") throw new Error("invalid route source manifest identity");
  const routes = requireArray(manifest.routeFiles, "manifest.routeFiles");
  const byKey = new Map<string, AnyRecord>();
  for (const routeValue of routes) {
    const route = requireObject(routeValue, "manifest.routeFiles entry");
    const sourceFile = requireString(route.sourceFile, "route sourceFile");
    const routeTemplate = requireString(route.routeTemplate, `${sourceFile}.routeTemplate`);
    if (normalizeNextRoutePath(sourceFile) !== routeTemplate) throw new Error(`route normalization drift: ${sourceFile}`);
    if (!/^[a-f0-9]{64}$/.test(requireString(route.sha256, `${sourceFile}.sha256`))) throw new Error(`invalid source hash: ${sourceFile}`);
    if (!/^[0-9a-f]{40}$/.test(requireString(route.gitBlobSha, `${sourceFile}.gitBlobSha`))) throw new Error(`invalid Git blob hash: ${sourceFile}`);
    const exports = requireObject(route.exports, `${sourceFile}.exports`);
    const resolved = requireArray(exports.resolved, `${sourceFile}.exports.resolved`);
    const hints = requireObject(route.operationHints, `${sourceFile}.operationHints`);
    for (const methodValue of resolved) {
      const method = requireString(methodValue, `${sourceFile}.exports.resolved method`);
      if (!(METHODS as readonly string[]).includes(method)) throw new Error(`unknown exported method ${method} in ${sourceFile}`);
      if (!hints[method]) throw new Error(`missing operation hint ${method} ${routeTemplate}`);
      const key = `${method} ${routeTemplate} ${sourceFile}`;
      if (byKey.has(key)) throw new Error(`duplicate exported method in one source file: ${key}`);
      byKey.set(key, route);
    }
  }
  const openapi = requireObject(manifest.openapi, "manifest.openapi");
  if (requireArray(openapi.operations, "manifest.openapi.operations").length !== openapi.operationCount) throw new Error("OpenAPI operation count drift");
  const discrepancies = requireObject(manifest.discrepancies, "manifest.discrepancies");
  requireArray(discrepancies.specificationOnlyMethods, "manifest.discrepancies.specificationOnlyMethods");
  return byKey;
}

function verifyDescriptor(operation: AnyRecord, routeByKey: Map<string, AnyRecord>): void {
  const operationId = requireString(operation.operationId, "operation.operationId");
  const method = requireString(operation.method, `${operationId}.method`);
  const path = requireString(operation.pathTemplate, `${operationId}.pathTemplate`);
  if (!(METHODS as readonly string[]).includes(method)) throw new Error(`invalid method ${method} at ${operationId}`);
  if (!/^\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z0-9._~-]+\})(?:\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z0-9._~-]+\}))*$/.test(path)) throw new Error(`invalid literal path template at ${operationId}`);
  for (const field of ["request", "response", "mediaType", "auth", "secrets", "pagination", "streaming", "confirmation", "retry", "source", "specification", "coverage"]) requireObject(operation[field], `${operationId}.${field}`);
  if (!["read", "unknown", "mutation", "secret", "lifecycle", "destructive"].includes(requireString(operation.sideEffect, `${operationId}.sideEffect`))) throw new Error(`invalid side effect: ${operationId}`);
  const source = requireObject(operation.source, `${operationId}.source`);
  const sourceFile = requireString(source.file, `${operationId}.source.file`);
  const route = routeByKey.get(`${method} ${path} ${sourceFile}`);
  if (!route) throw new Error(`operation has no pinned exported handler: ${operationId}`);
  if (sourceFile !== route.sourceFile || source.sha256 !== route.sha256 || source.gitBlobSha !== route.gitBlobSha) throw new Error(`source hash drift: ${operationId}`);
  const coverage = requireObject(operation.coverage, `${operationId}.coverage`);
  const status = requireString(coverage.status, `${operationId}.coverage.status`);
  if (status === "invokable" && (!coverage.adapterId || typeof coverage.adapterId !== "string")) throw new Error(`missing typed adapter: ${operationId}`);
  if (status === "non-invokable") {
    const reason = requireString(coverage.reason, `${operationId}.coverage.reason`);
    if (!ALLOWED_NON_INVOKABLE.some((prefix) => reason.startsWith(prefix))) throw new Error(`unclassified non-invokable route: ${operationId}`);
    if (coverage.adapterId !== null) throw new Error(`non-invokable route has an adapter: ${operationId}`);
  } else if (status !== "invokable") throw new Error(`unclassified coverage status: ${operationId}`);
  const auth = requireObject(operation.auth, `${operationId}.auth`);
  if (!["public", "runtime", "management", "local"].includes(String(auth.domain))) throw new Error(`invalid auth domain: ${operationId}`);
  const retry = requireObject(operation.retry, `${operationId}.retry`);
  if (retry.allowed === true && retry.maxAttempts !== 2) throw new Error(`unsafe retry policy: ${operationId}`);
  if (retry.allowed === false && retry.maxAttempts !== 1) throw new Error(`retry policy drift: ${operationId}`);
  const specification = requireObject(operation.specification, `${operationId}.specification`);
  if (specification.documented === true && typeof specification.path !== "string") throw new Error(`documented operation has no specification path: ${operationId}`);
  if (specification.documented === false && requireArray(specification.discrepancies, `${operationId}.specification.discrepancies`).length === 0) throw new Error(`undocumented operation lacks discrepancy: ${operationId}`);
  if (path.includes("/openapi/try") && status !== "non-invokable") throw new Error("arbitrary OpenAPI executor must never be invokable");
}

function verifyEligibility(operations: AnyRecord): void {
  const eligibility = readJson(eligibilityPath);
  if (eligibility.schemaVersion !== 1 || eligibility.recordKind !== "omniroute-release-eligibility") throw new Error("invalid release eligibility identity");
  const release = requireObject(eligibility.release, "eligibility.release");
  if (release.repository !== "diegosouzapw/OmniRoute" || release.tag !== "v3.8.50" || release.commit !== "5458026c216f77a3da68ea49152dc33470cfe2cb") throw new Error("eligibility release selector drift");
  const fallback = requireObject(eligibility.default, "eligibility.default");
  if (fallback.status !== "unavailable" || typeof fallback.reason !== "string" || fallback.reason.length === 0) throw new Error("eligibility default must deny without evidence");
  const inventory = new Map<string, AnyRecord>();
  for (const value of requireArray(operations.operations, "operations.operations")) {
    const operation = requireObject(value, "operations entry");
    inventory.set(requireString(operation.operationId, "operation.operationId"), operation);
  }
  const seen = new Set<string>();
  for (const value of requireArray(eligibility.operations, "eligibility.operations")) {
    const record = requireObject(value, "eligibility operation");
    const operationId = requireString(record.operationId, "eligibility.operationId");
    if (seen.has(operationId)) throw new Error(`duplicate eligibility record: ${operationId}`);
    seen.add(operationId);
    const operation = inventory.get(operationId);
    if (!operation) throw new Error(`eligibility operation is not in inventory: ${operationId}`);
    if (record.status !== "verified") throw new Error(`eligibility records must explicitly verify or omit an operation: ${operationId}`);
    const source = requireObject(operation.source, `${operationId}.source`);
    const evidenceSource = requireObject(record.source, `${operationId}.eligibility.source`);
    if (evidenceSource.file !== source.file || evidenceSource.sha256 !== source.sha256 || evidenceSource.gitBlobSha !== source.gitBlobSha) throw new Error(`eligibility source drift: ${operationId}`);
    const evidence = requireArray(record.evidence, `${operationId}.eligibility.evidence`);
    if (evidence.length === 0) throw new Error(`eligibility evidence is empty: ${operationId}`);
    for (const item of evidence) {
      const entry = requireObject(item, `${operationId}.eligibility.evidence entry`);
      if (!requireString(entry.kind, `${operationId}.eligibility.evidence.kind`) || !requireString(entry.detail, `${operationId}.eligibility.evidence.detail`)) throw new Error(`eligibility evidence is incomplete: ${operationId}`);
    }
    if (record.response !== undefined) {
      const response = requireObject(record.response, `${operationId}.eligibility.response`);
      const required = requireArray(response.required, `${operationId}.eligibility.response.required`);
      const properties = requireObject(response.properties, `${operationId}.eligibility.response.properties`);
      for (const fieldValue of required) {
        const field = requireString(fieldValue, `${operationId}.eligibility.response.required field`);
        if (!Object.prototype.hasOwnProperty.call(properties, field)) throw new Error(`eligibility response required field has no rule: ${operationId}.${field}`);
      }
      for (const [field, value] of Object.entries(properties)) {
        const property = requireObject(value, `${operationId}.eligibility.response.${field}`);
        if (property.type !== "string") throw new Error(`eligibility response rule is not string: ${operationId}.${field}`);
        if (property.format !== undefined && property.format !== "date-time") throw new Error(`eligibility response format is unsupported: ${operationId}.${field}`);
      }
    }
  }
}

export function verifyContracts(): void {
  const manifest = readJson(manifestPath);
  const operations = readJson(operationsPath);
  verifyRelease(manifest, operations);
  verifyEligibility(operations);
  const routeByKey = verifyManifest(manifest);
  const generated = generateContracts();
  const expected = readFileSync(operationsPath, "utf8");
  if (generated !== expected) throw new Error("operations.json does not match deterministic generator output (hash drift or stale inventory)");
  const generatedFrom = requireObject(operations.generatedFrom, "operations.generatedFrom");
  const manifestHash = sha256(canonicalJson(JSON.parse(readFileSync(manifestPath, "utf8"))));
  if (generatedFrom.manifestSha256 !== manifestHash) throw new Error("operations manifest hash drift");
  const operationValues = requireArray(operations.operations, "operations.operations");
  if (!operationValues.length) throw new Error("operations inventory is empty");
  const seenOperationIds = new Set<string>();
  for (const value of operationValues) {
    const operation = requireObject(value, "operations entry");
    const operationId = requireString(operation.operationId, "operation.operationId");
    if (seenOperationIds.has(operationId)) throw new Error(`duplicate operation ID: ${operationId}`);
    seenOperationIds.add(operationId);
    verifyDescriptor(operation, routeByKey);
  }
  const counts = requireObject(operations.counts, "operations.counts");
  const manifestRoutes = requireArray(manifest.routeFiles, "manifest.routeFiles");
  if (requireNumber(counts.sourceOperations, "operations.counts.sourceOperations") !== operationValues.length || requireNumber(counts.routeFiles, "operations.counts.routeFiles") !== manifestRoutes.length) throw new Error("operation count drift");
  if (requireNumber(counts.invokableOperations, "operations.counts.invokableOperations") + requireNumber(counts.nonInvokableOperations, "operations.counts.nonInvokableOperations") !== operationValues.length) throw new Error("coverage count drift");
}

if (import.meta.main) verifyContracts();
