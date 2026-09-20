import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Method = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";
const METHODS: Method[] = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(packageRoot, "provenance/route-sources.json");
const outputPath = resolve(packageRoot, "contracts/operations.json");

function sortJson(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: Json): string {
  return JSON.stringify(sortJson(value));
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Convert Next App Router route folders to literal adapter path templates. */
export function normalizeNextRoutePath(sourceFile: string): string {
  const relative = sourceFile.replace(/^src\/app\//, "").replace(/\/route\.ts$/, "");
  const parts: string[] = [];
  for (const part of relative.split("/")) {
    if (part.startsWith("(") && part.endsWith(")")) continue;
    if (part.startsWith("@")) continue;
    if (part.startsWith("[[...") && part.endsWith("]]")) parts.push(`{${part.slice(5, -2)}}`);
    else if (part.startsWith("[...") && part.endsWith("]")) parts.push(`{${part.slice(4, -1)}}`);
    else if (part.startsWith("[") && part.endsWith("]")) parts.push(`{${part.slice(1, -1)}}`);
    else parts.push(part);
  }
  return `/${parts.filter(Boolean).join("/")}`;
}

function shapePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, "{}");
}

function jsonRecord(value: Json): { [key: string]: Json } | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function objectSchema(properties: Record<string, Json>, required: string[], additionalProperties: boolean): Json {
  const out: Record<string, Json> = { type: "object", properties, additionalProperties };
  if (required.length) out.required = [...new Set(required)].sort();
  return out;
}

function pathSchema(path: string): Json {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].flatMap((match) => {
    const name = match[1];
    return name === undefined ? [] : [name];
  });
  return objectSchema(Object.fromEntries(names.map((name) => [name, { type: "string" }])), names, false);
}

function specFor(manifest: any, method: Method, path: string): any | null {
  const operations = manifest.openapi.operations as any[];
  const exact = operations.find((item) => item.method === method && item.path === path);
  if (exact) return exact;
  const shapeMatches = operations.filter((item) => item.method === method && shapePath(item.path) === shapePath(path));
  return shapeMatches.length === 1 ? shapeMatches[0] : null;
}

function querySchema(spec: any | null, hint: any): Json {
  const properties: Record<string, Json> = {};
  const required: string[] = [];
  for (const parameter of spec?.parameters ?? []) {
    if (parameter.in !== "query" || !parameter.name) continue;
    properties[parameter.name] = parameter.schema ?? { type: "string" };
    if (parameter.required) required.push(parameter.name);
  }
  if (Object.keys(properties).length || required.length) return objectSchema(properties, required, false);
  return objectSchema({}, [], Boolean(hint.queryAdditionalProperties));
}

function bodyFor(spec: any | null, hint: any): Json {
  if (spec?.requestBody) return spec.requestBody;
  return hint.fallbackBody ?? null;
}

function responseFor(spec: any | null, hint: any): any {
  const success = (spec?.responses ?? []).find((item: any) => String(item.statusCode).startsWith("2"));
  return success ? { statusCodes: [success.statusCode], mediaType: success.mediaType, schema: success.schema } : hint.fallbackResponse;
}

function specDomain(spec: any | null): string {
  const names = new Set<string>();
  for (const security of spec?.security ?? []) for (const name of Object.keys(security)) names.add(name);
  if (names.has("BearerAuth") || names.has("ApiKeyAuth")) return "runtime";
  return names.size ? "management" : "public";
}

function discrepancies(method: Method, path: string, authDomain: string, spec: any | null): Json[] {
  if (!spec) return [{ code: "undocumented-source-operation", authority: "source", detail: "Exported handler operation is absent from docs/openapi.yaml; source behavior is authoritative." }];
  const result: Json[] = [];
  if (spec.path !== path) result.push({ code: "spec-path-template-mismatch", authority: "source", detail: `OpenAPI uses ${spec.path} while the exported handler normalizes to ${path}; source template wins.` });
  const documentedDomain = specDomain(spec);
  if (documentedDomain !== authDomain && !(documentedDomain === "public" && authDomain === "runtime" && path.startsWith("/api/v1"))) {
    result.push({ code: "spec-auth-mismatch", authority: "source", detail: `OpenAPI security maps to ${documentedDomain}; handler behavior maps to ${authDomain}.` });
  }
  return result;
}

function makeOperation(manifest: any, route: any, method: Method, duplicateIndex: number, primarySource: string | null): any {
  const path = normalizeNextRoutePath(route.sourceFile);
  if (path !== route.routeTemplate) throw new Error(`route template drift: ${route.sourceFile}`);
  const hint = route.operationHints?.[method];
  if (!hint) throw new Error(`missing operation hint: ${method} ${path}`);
  const spec = specFor(manifest, method, path);
  const body = bodyFor(spec, hint);
  const response = responseFor(spec, hint);
  const scopes = [...new Set((spec?.security ?? []).flatMap((security: any) => Object.values(security).flatMap((values: any) => values ?? [])))].sort();
  const operationId = `${method} ${path}${duplicateIndex ? ` [alias ${duplicateIndex}]` : ""}`;
  let coverage: any = { status: "invokable", adapterId: `typed.${(method + " " + path).toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "")}`, reason: null };
  if (route.classification !== "external") coverage = { status: "non-invokable", adapterId: null, reason: route.classificationReason };
  else if (duplicateIndex) coverage = { status: "non-invokable", adapterId: null, reason: `True duplicate alias of ${method} ${path}; primary source is ${primarySource}.` };
  const bodyRecord = jsonRecord(body);
  return {
    operationId,
    method,
    pathTemplate: path,
    request: { pathSchema: pathSchema(path), querySchema: querySchema(spec, hint), body },
    response,
    mediaType: { request: bodyRecord?.mediaType ?? null, response: response.mediaType },
    auth: { domain: hint.authDomain, scopes },
    secrets: hint.secrets,
    sideEffect: hint.sideEffect,
    pagination: hint.pagination,
    streaming: hint.streaming,
    confirmation: { required: hint.sideEffect !== "read" || hint.secrets.inputFields.length > 0 || hint.secrets.outputFields.length > 0 || hint.sideEffect === "unknown", reason: hint.sideEffect === "read" && !hint.secrets.inputFields.length && !hint.secrets.outputFields.length ? "No mutation is declared by the pinned source." : hint.sideEffect === "unknown" ? "Source does not prove this nominal read is side-effect free." : ["destructive", "lifecycle"].includes(hint.sideEffect) ? "Human confirmation required for lifecycle or destructive side effects." : hint.sideEffect === "read" ? "Human confirmation required before secret-bearing access." : "Human confirmation required before state or secret mutation/disclosure." },
    retry: { allowed: ["GET", "HEAD", "OPTIONS"].includes(method) && hint.sideEffect === "read" && ["json", "binary"].includes(hint.streaming.mode), maxAttempts: ["GET", "HEAD", "OPTIONS"].includes(method) && hint.sideEffect === "read" && ["json", "binary"].includes(hint.streaming.mode) ? 2 : 1, statusCodes: ["GET", "HEAD", "OPTIONS"].includes(method) && hint.sideEffect === "read" && ["json", "binary"].includes(hint.streaming.mode) ? [429, 502, 503, 504] : [] },
    source: { file: route.sourceFile, sha256: route.sha256, gitBlobSha: route.gitBlobSha, export: route.exports.direct.includes(method) ? "direct" : "re-export" },
    specification: { documented: Boolean(spec), path: spec?.path ?? null, operationId: spec?.operationId ?? null, discrepancies: discrepancies(method, path, hint.authDomain, spec) },
    coverage,
  };
}

export function generateOperations(manifest: any): any {
  const source: any[] = [];
  for (const route of [...manifest.routeFiles].sort((a, b) => compareText(a.sourceFile, b.sourceFile))) {
    for (const method of [...route.exports.resolved].sort((a: Method, b: Method) => METHODS.indexOf(a) - METHODS.indexOf(b))) source.push({ route, method, path: normalizeNextRoutePath(route.sourceFile) });
  }
  const groups = new Map<string, any[]>();
  for (const item of source) {
    const key = `${item.method} ${item.path}`;
    const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
  }
  for (const group of groups.values()) group.sort((a, b) => compareText(a.route.sourceFile, b.route.sourceFile));
  const operations = source.sort((a, b) => compareText(a.method, b.method) || compareText(a.path, b.path) || compareText(a.route.sourceFile, b.route.sourceFile)).map((item) => {
    const group = groups.get(`${item.method} ${item.path}`)!;
    const index = group.indexOf(item);
    return makeOperation(manifest, item.route, item.method, index, group[0]?.route.sourceFile ?? null);
  });
  const methodCounts = Object.fromEntries(METHODS.map((method) => [method, source.filter((item) => item.method === method).length]));
  const invokable = operations.filter((operation) => operation.coverage.status === "invokable").length;
  const manifestHash = sha256(canonicalJson(manifest));
  return {
    $schema: "./operations.schema.json",
    schemaVersion: 1,
    recordKind: "omniroute-operation-contract",
    release: manifest.release,
    generatedFrom: { manifest: "provenance/route-sources.json", manifestSha256: manifestHash, authority: "source handler manifest with OpenAPI discrepancy records" },
    counts: { routeFiles: manifest.routeFiles.length, sourceOperations: source.length, openapiPaths: manifest.openapi.pathCount, openapiOperations: manifest.openapi.operationCount, documentedOperations: operations.filter((operation) => operation.specification.documented).length, unmatchedSpecificationMethods: manifest.discrepancies.specificationOnlyMethods.length, invokableOperations: invokable, nonInvokableOperations: operations.length - invokable, methodCounts },
    operations,
  };
}

export function generateContracts(): string {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return `${JSON.stringify(sortJson(generateOperations(manifest)), null, 2)}\n`;
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const expected = readFileSync(outputPath, "utf8");
    const generated = generateContracts();
    if (expected !== generated) throw new Error("operations.json is stale; run bun scripts/generate-contracts.ts");
  } else {
    writeFileSync(outputPath, generateContracts());
  }
}
