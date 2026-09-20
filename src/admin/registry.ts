import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AdminMethod, AdminRisk, AdminSideEffect, JsonObject, JsonValue } from "./types.ts";
import { escapeControls } from "./types.ts";
import { createEligibilityIndex, eligibilityFor, isVerifiedEligibility, type EligibilityOptions, type OperationEligibilityRecord } from "./eligibility.ts";

export interface JsonSchema {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly pattern?: string;
  readonly format?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly default?: unknown;
}

export interface OperationRequest {
  readonly pathSchema: JsonSchema;
  readonly querySchema: JsonSchema;
  readonly body: { readonly required: boolean; readonly mediaType: string | null; readonly schema: JsonSchema } | null;
}

export interface OperationDescriptor {
  readonly operationId: string;
  readonly method: AdminMethod;
  readonly pathTemplate: string;
  readonly request: OperationRequest;
  readonly response: { readonly statusCodes: readonly string[]; readonly mediaType: string; readonly schema: JsonSchema };
  readonly mediaType: { readonly request: string | null; readonly response: string };
  readonly auth: { readonly domain: "public" | "runtime" | "management" | "local"; readonly scopes: readonly string[] };
  readonly secrets: { readonly inputFields: readonly string[]; readonly outputFields: readonly string[] };
  readonly sideEffect: AdminSideEffect;
  readonly pagination: { readonly mode: "none" | "offset" | "cursor"; readonly parameters: readonly string[] };
  readonly streaming: { readonly mode: "json" | "sse" | "websocket" | "binary"; readonly framing: string };
  readonly confirmation: { readonly required: boolean; readonly reason: string };
  readonly retry: { readonly allowed: boolean; readonly maxAttempts: number; readonly statusCodes: readonly number[] };
  readonly source: { readonly file: string; readonly sha256: string; readonly gitBlobSha: string; readonly export: "direct" | "re-export" };
  readonly specification: { readonly documented: boolean; readonly path: string | null; readonly operationId: string | null; readonly discrepancies: readonly unknown[] };
  readonly coverage: { readonly status: "invokable" | "non-invokable"; readonly adapterId: string | null; readonly reason: string | null };
}

export interface ValidatedOperationInput {
  readonly path: JsonObject;
  readonly query: JsonObject;
  readonly body?: JsonValue;
}

export interface OperationAdapter {
  readonly adapterId: string;
  readonly category: string;
  readonly descriptor: OperationDescriptor;
  readonly risk: AdminRisk;
  readonly validate: (input: unknown) => ValidatedOperationInput;
  readonly project: (response: unknown) => unknown;
  readonly buildPath: (input: ValidatedOperationInput) => string;
  readonly eligibility: OperationEligibilityRecord;
}

export interface OperationListFilter {
  readonly category?: string;
  readonly method?: AdminMethod;
  readonly sideEffect?: AdminSideEffect;
  readonly authDomain?: OperationDescriptor["auth"]["domain"];
  readonly search?: string;
}

export class RegistryError extends Error {
  readonly code: "unknown-operation" | "non-invokable" | "invalid-input" | "invalid-inventory";
  readonly operationId: string | undefined;
  readonly field: string | undefined;
  constructor(code: RegistryError["code"], message: string, operationId?: string, field?: string) {
    super(escapeControls(message));
    this.name = "RegistryError";
    this.code = code;
    this.operationId = operationId;
    this.field = field;
  }
}

type RawRecord = Record<string, unknown>;
type SchemaDocument = RawRecord;
let inventoryDocument: SchemaDocument | undefined;
let contractSchemaDocument: SchemaDocument | undefined;

function readContractSchema(): SchemaDocument | undefined {
  if (contractSchemaDocument) return contractSchemaDocument;
  const path = resolve(import.meta.dir, "../../contracts/operations.schema.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("schema is not an object");
    contractSchemaDocument = parsed;
    return parsed;
  } catch {
    return undefined;
  }
}
const METHODS: readonly AdminMethod[] = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];
const METHOD_SET = new Set<string>(METHODS);
const RISK_ORDER: Record<AdminSideEffect, AdminRisk> = {
  read: "read",
  unknown: "gated-read",
  mutation: "mutation",
  secret: "secret",
  lifecycle: "lifecycle",
  destructive: "destructive",
};
const SECRET_NAMES = new Set([
  "apiKey", "api_key", "apikey", "api-key", "password", "passwd", "secret", "clientSecret", "client_secret",
  "authorization", "cookie", "set-cookie", "accessToken", "access_token", "refreshToken", "refresh_token", "auth_token", "token",
]);

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): RawRecord {
  if (!isRecord(value)) throw new RegistryError("invalid-inventory", `${label} must be an object`);
  return value;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new RegistryError("invalid-inventory", `${label} must be a non-empty string`);
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as RawRecord)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function loadInventory(): OperationDescriptor[] {
  const path = resolve(import.meta.dir, "../../contracts/operations.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new RegistryError("invalid-inventory", `operation inventory unavailable: ${error instanceof Error ? error.name : "read-failure"}`);
  }
  const root = assertRecord(parsed, "operation inventory");
  inventoryDocument = root;
  if (!Array.isArray(root.operations)) throw new RegistryError("invalid-inventory", "operation inventory operations must be an array");
  const seen = new Set<string>();
  const descriptors: OperationDescriptor[] = [];
  for (const item of root.operations) {
    const operation = assertRecord(item, "operation descriptor");
    const operationId = assertString(operation.operationId, "operationId");
    if (seen.has(operationId)) throw new RegistryError("invalid-inventory", `duplicate operation ${operationId}`);
    seen.add(operationId);
    const method = assertString(operation.method, `${operationId}.method`);
    if (!METHOD_SET.has(method)) throw new RegistryError("invalid-inventory", `unsupported method ${method}`);
    const descriptor = operation as unknown as OperationDescriptor;
    if (descriptor.coverage.status === "invokable" && !descriptor.coverage.adapterId) throw new RegistryError("invalid-inventory", `missing adapter for ${operationId}`);
    descriptors.push(clone(descriptor));
  }
  return descriptors;
}

function categoryFor(pathTemplate: string): string {
  const parts = pathTemplate.split("/").filter(Boolean);
  const first = parts[0];
  if (!first) return "root";
  if (first === "api") {
    const section = parts[1];
    return section && !section.startsWith("{") ? `api/${section}` : "api";
  }
  return first;

}
function assertJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new RegistryError("invalid-input", "number must be finite", undefined, path);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertJsonValue(value[index], `${path}[${index}]`);
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (/[^\x20-\x7e]/.test(key)) throw new RegistryError("invalid-input", "field name contains control characters", undefined, path);
      assertJsonValue(child, `${path}.${key}`);
    }
    return;
  }
  throw new RegistryError("invalid-input", "value must be JSON", undefined, path);
}
function schemaRefTarget(ref: string, operationId: string): JsonSchema {
  if (!ref.startsWith("#/") || /(?:^|\/)\.\.(?:\/|$)/.test(ref)) {
    throw new RegistryError("invalid-inventory", `external or unsafe schema reference ${ref}`, operationId);
  }
  const segments = ref.slice(2).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  const roots = [inventoryDocument, readContractSchema()].filter((root): root is SchemaDocument => root !== undefined);
  for (const root of roots) {
    let current: unknown = root;
    for (const segment of segments) {
      if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
        current = undefined;
        break;
      }
      current = current[segment];
    }
    if (isRecord(current)) return current as JsonSchema;
  }
  throw new RegistryError("invalid-inventory", `unknown local schema reference ${ref}`, operationId);
}

function resolveSchema(schema: JsonSchema, operationId: string, seen = new Set<string>()): JsonSchema {
  const ref = schema.$ref;
  if (!ref) return schema;
  if (seen.has(ref)) throw new RegistryError("invalid-inventory", `cyclic schema reference ${ref}`, operationId);
  const nextSeen = new Set(seen);
  nextSeen.add(ref);
  const target = resolveSchema(schemaRefTarget(ref, operationId), operationId, nextSeen);
  const { $ref: _ignored, ...siblings } = schema;
  return { ...target, ...siblings };
}


function schemaTypeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "object": return isRecord(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true;
  }
}

function schemaError(operationId: string, field: string, detail: string): never {
  throw new RegistryError("invalid-input", `${field}: ${detail}`, operationId, field);
}

function validateSchema(schema: JsonSchema | null | undefined, value: unknown, field: string, operationId: string): void {
  if (!schema) return;
  schema = resolveSchema(schema, operationId);
  if (schema.oneOf && schema.oneOf.length > 0) {
    const matches = schema.oneOf.filter((candidate) => {
      try { validateSchema(candidate, value, field, operationId); return true; } catch { return false; }
    }).length;
    if (matches !== 1) schemaError(operationId, field, "does not match exactly one allowed shape");
    return;
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    if (!schema.anyOf.some((candidate) => { try { validateSchema(candidate, value, field, operationId); return true; } catch { return false; } })) schemaError(operationId, field, "does not match an allowed shape");
    return;
  }
  if (schema.allOf) for (const candidate of schema.allOf) validateSchema(candidate, value, field, operationId);
  if (schema.enum && !schema.enum.some((allowed) => Object.is(allowed, value))) schemaError(operationId, field, "has an invalid value");
  const types = schema.type === undefined ? [] : (typeof schema.type === "string" ? [schema.type] : schema.type);
  if (types.length > 0 && !types.some((type) => schemaTypeMatches(type, value))) schemaError(operationId, field, "has an invalid type");
  if (typeof value === "string") {
    if (/[\u0000-\u001f\u007f]/.test(value)) schemaError(operationId, field, "contains control characters");
    if (schema.minLength !== undefined && value.length < schema.minLength) schemaError(operationId, field, "is too short");
    if (schema.maxLength !== undefined && value.length > schema.maxLength) schemaError(operationId, field, "is too long");
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) schemaError(operationId, field, "has an invalid format");
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) schemaError(operationId, field, "is below minimum");
    if (schema.maximum !== undefined && value > schema.maximum) schemaError(operationId, field, "is above maximum");
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) schemaError(operationId, field, "has too few items");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) schemaError(operationId, field, "has too many items");
    if (schema.items) value.forEach((item, index) => validateSchema(schema.items, item, `${field}[${index}]`, operationId));
  }
  if (isRecord(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) schemaError(operationId, `${field}.${required}`, "is required");
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema) validateSchema(childSchema, child, `${field}.${key}`, operationId);
      else if (schema.additionalProperties === false || schema.additionalProperties === undefined) schemaError(operationId, `${field}.${key}`, "is not allowed");
      else if (isRecord(schema.additionalProperties)) validateSchema(schema.additionalProperties, child, `${field}.${key}`, operationId);
    }
  }
}
function validateMultipartBody(body: unknown, operationId: string): void {
  if (!isRecord(body)) schemaError(operationId, "body", "must be an object");
  const files = body.files;
  if (files !== undefined) {
    if (!Array.isArray(files)) schemaError(operationId, "body.files", "must be an array");
    files.forEach((entry, index) => {
      if (!isRecord(entry)) schemaError(operationId, `body.files[${index}]`, "must be an object");
      const allowed = new Set(["field", "path", "filename", "contentType"]);
      for (const key of Object.keys(entry)) if (!allowed.has(key)) schemaError(operationId, `body.files[${index}].${key}`, "is not allowed");
      for (const required of ["field", "path"]) {
        if (typeof entry[required] !== "string" || entry[required].length === 0) schemaError(operationId, `body.files[${index}].${required}`, "must be a non-empty string");
      }
      const field = entry.field as string;
      const path = entry.path as string;
      if (/[\u0000-\u001f\u007f]/.test(field) || field.length > 200) schemaError(operationId, `body.files[${index}].field`, "contains unsafe characters");
      if (!isAbsolute(path) || /[\u0000\r\n]/.test(path)) schemaError(operationId, `body.files[${index}].path`, "must be an absolute path without control characters");
      if (entry.filename !== undefined && (typeof entry.filename !== "string" || entry.filename.length === 0 || entry.filename.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(entry.filename))) {
        schemaError(operationId, `body.files[${index}].filename`, "is invalid");
      }
      if (entry.contentType !== undefined && (typeof entry.contentType !== "string" || entry.contentType.length === 0 || entry.contentType.length > 256 || /[\u0000-\u001f\u007f]/.test(entry.contentType) || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$/.test(entry.contentType))) {
        schemaError(operationId, `body.files[${index}].contentType`, "is invalid");
      }
    });
  }
  if (body.fields !== undefined) {
    if (!isRecord(body.fields)) schemaError(operationId, "body.fields", "must be an object");
    assertJsonValue(body.fields, "body.fields");
  }
}


function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function buildPath(pathTemplate: string, path: JsonObject, operationId: string): string {
  const built = pathTemplate.replace(/\{([A-Za-z0-9._~-]+)\}/g, (_, key: string) => {
    const value = path[key];
    if (typeof value !== "string" && typeof value !== "number") schemaError(operationId, `path.${key}`, "must be a string or number");
    if (typeof value === "string") {
      let decoded = value;
      for (let boundary = 0; boundary < 2; boundary++) {
        if (decoded === "." || decoded === ".." || /[\\/\u0000-\u001f\u007f]/.test(decoded)) schemaError(operationId, `path.${key}`, "contains an unsafe path segment");
        try { decoded = decodeURIComponent(decoded); } catch { schemaError(operationId, `path.${key}`, "contains invalid encoding"); }
      }
      if (decoded === "." || decoded === ".." || /[\\/\u0000-\u001f\u007f]/.test(decoded)) schemaError(operationId, `path.${key}`, "contains an ambiguous path segment");
    }
    return encodeURIComponent(String(value));
  });
  if (/\{/.test(built)) schemaError(operationId, "path", "is missing a required parameter");
  return built;
}

function isSecretKey(key: string, descriptor: OperationDescriptor): boolean {
  if (descriptor.secrets.outputFields.some((field) => field.toLowerCase() === key.toLowerCase())) return true;
  return SECRET_NAMES.has(key) || /(?:secret|password|token|credential|authorization|cookie|api[-_]?key)/i.test(key);
}

function projectNode(value: unknown, schema: JsonSchema | undefined, descriptor: OperationDescriptor, key?: string): unknown {
  if (schema) schema = resolveSchema(schema, descriptor.operationId);
  if (key && isSecretKey(key, descriptor)) return undefined;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" ? escapeControls(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => projectNode(item, schema?.items, descriptor)).filter((item) => item !== undefined);
  }
  if (!isRecord(value)) return undefined;
  // Response schemas are an explicit allowlist. `additionalProperties` describes
  // what the upstream may return, not what is safe to expose to an agent.
  const properties = schema?.properties ?? {};
  const output: JsonObject = {};
  for (const [field, childSchema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const projected = projectNode(value[field], childSchema, descriptor, field);
    if (projected !== undefined) output[escapeControls(field)] = projected as JsonValue;
  }
  return output;
}

export function projectResponse(descriptor: OperationDescriptor, response: unknown): unknown {
  if (descriptor.sideEffect === "secret" || descriptor.secrets.outputFields.length > 0) {
    if (!isRecord(response) && !Array.isArray(response)) return undefined;
    if (Array.isArray(response) && response.some((item) => !isRecord(item))) return undefined;
  }
  return projectNode(response, descriptor.response.schema, descriptor);
}

function projectVerifiedResponse(descriptor: OperationDescriptor, eligibility: OperationEligibilityRecord, response: unknown): unknown {
  const contract = eligibility.response;
  if (!contract) return projectResponse(descriptor, response);
  if (!isRecord(response)) throw new RegistryError("invalid-inventory", `verified response for ${descriptor.operationId} is not an object`, descriptor.operationId);
  for (const field of contract.required) {
    if (typeof response[field] !== "string") throw new RegistryError("invalid-inventory", `verified response field ${field} is missing or invalid`, descriptor.operationId, field);
  }
  const output: JsonObject = {};
  for (const [field, rule] of Object.entries(contract.properties)) {
    const value = response[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) throw new RegistryError("invalid-inventory", `verified response field ${field} is invalid`, descriptor.operationId, field);
    if (rule.enum !== undefined && !rule.enum.includes(value)) throw new RegistryError("invalid-inventory", `verified response field ${field} has an invalid value`, descriptor.operationId, field);
    if (rule.format === "date-time" && (!value.includes("T") || !Number.isFinite(Date.parse(value)))) throw new RegistryError("invalid-inventory", `verified response field ${field} is not a date-time`, descriptor.operationId, field);
    output[field] = escapeControls(value);
  }
  return output;
}

export function operationRisk(descriptor: OperationDescriptor): AdminRisk {
  return RISK_ORDER[descriptor.sideEffect];
}

export class OperationRegistry {
  readonly #descriptors: readonly OperationDescriptor[];
  readonly #adapters: ReadonlyMap<string, OperationAdapter>;
  readonly #eligibility: ReadonlyMap<string, OperationEligibilityRecord>;
  constructor(descriptors: readonly OperationDescriptor[] = loadInventory(), options: EligibilityOptions = {}) {
    this.#eligibility = createEligibilityIndex(options);
    const adapterMap = new Map<string, OperationAdapter>();
    for (const descriptor of descriptors) {
      if (descriptor.coverage.status !== "invokable" || descriptor.coverage.adapterId === null) continue;
      if (adapterMap.has(descriptor.operationId)) throw new RegistryError("invalid-inventory", `duplicate invokable operation ${descriptor.operationId}`, descriptor.operationId);
      const configuredEligibility = eligibilityFor(descriptor.operationId, this.#eligibility);
      const eligibility = configuredEligibility.status === "verified" && !isVerifiedEligibility(configuredEligibility, descriptor.source)
        ? {
            operationId: descriptor.operationId,
            status: "unavailable" as const,
            reason: "Eligibility evidence does not match the pinned operation source.",
          }
        : configuredEligibility;
      const adapter: OperationAdapter = deepFreeze({
        adapterId: descriptor.coverage.adapterId,
        category: categoryFor(descriptor.pathTemplate),
        descriptor: deepFreeze(clone(descriptor)),
        risk: operationRisk(descriptor),
        validate: (input: unknown) => this.validate(descriptor, input),
        project: (response: unknown) => projectVerifiedResponse(descriptor, eligibility, response),
        buildPath: (input: ValidatedOperationInput) => buildPath(descriptor.pathTemplate, input.path, descriptor.operationId),
        eligibility: deepFreeze(eligibility),
      });
      adapterMap.set(descriptor.operationId, adapter);
    }
    const invokableCount = descriptors.filter((descriptor) => descriptor.coverage.status === "invokable" && descriptor.coverage.adapterId !== null).length;
    if (adapterMap.size !== invokableCount) throw new RegistryError("invalid-inventory", "inventory coverage is incomplete");
    this.#descriptors = deepFreeze(descriptors.map(clone));
    this.#adapters = adapterMap;
  }

  get size(): number {
    return this.#adapters.size;
  }

  getOperation(operationId: string): OperationDescriptor | undefined {
    const descriptor = this.#descriptors.find((item) => item.operationId === operationId);
    return descriptor ? clone(descriptor) : undefined;
  }

  getEligibility(operationId: string): OperationEligibilityRecord {
    const descriptor = this.#descriptors.find((item) => item.operationId === operationId);
    const configured = eligibilityFor(operationId, this.#eligibility);
    if (!descriptor) return { operationId, status: "unavailable", reason: "Operation is not present in the closed inventory." };
    if (configured.status !== "verified" || isVerifiedEligibility(configured, descriptor.source)) return configured;
    return { operationId, status: "unavailable", reason: "Eligibility evidence does not match the pinned operation source." };
  }

  lookup(operationId: string): OperationAdapter | undefined {
    const adapter = this.#adapters.get(operationId);
    return adapter ? adapter : undefined;
  }

  require(operationId: string): OperationAdapter {
    const adapter = this.#adapters.get(operationId);
    if (adapter) return adapter;
    const descriptor = this.#descriptors.find((item) => item.operationId === operationId);
    if (descriptor) throw new RegistryError("non-invokable", `operation ${operationId} is not invokable`, operationId);
    throw new RegistryError("unknown-operation", "operation is not in the closed inventory", operationId);
  }

  listOperations(filter: OperationListFilter = {}): readonly OperationAdapter[] {
    const search = filter.search?.toLowerCase();
    return [...this.#adapters.values()]
      .filter((adapter) => filter.category === undefined || adapter.category === filter.category)
      .filter((adapter) => filter.method === undefined || adapter.descriptor.method === filter.method)
      .filter((adapter) => filter.sideEffect === undefined || adapter.descriptor.sideEffect === filter.sideEffect)
      .filter((adapter) => filter.authDomain === undefined || adapter.descriptor.auth.domain === filter.authDomain)
      .filter((adapter) => search === undefined || `${adapter.descriptor.operationId} ${adapter.descriptor.pathTemplate}`.toLowerCase().includes(search))
      .sort((left, right) => left.descriptor.operationId.localeCompare(right.descriptor.operationId));
  }

  listCategories(): readonly string[] {
    return [...new Set([...this.#adapters.values()].map((adapter) => adapter.category))].sort();
  }

  validateOperation(operationId: string, input: unknown): ValidatedOperationInput {
    return this.require(operationId).validate(input);
  }

  project(operationId: string, response: unknown): unknown {
    return this.require(operationId).project(response);
  }

  buildRequestPath(operationId: string, input: ValidatedOperationInput): string {
    return this.require(operationId).buildPath(input);
  }

  descriptors(): readonly OperationDescriptor[] {
    return this.#descriptors.map(clone);
  }

  private validate(descriptor: OperationDescriptor, input: unknown): ValidatedOperationInput {
    if (!isRecord(input)) throw new RegistryError("invalid-input", "input must be an object", descriptor.operationId);
    const allowed = new Set(["path", "query", "body"]);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new RegistryError("invalid-input", `input.${key}: is not allowed`, descriptor.operationId, `input.${key}`);
    const path = input.path === undefined ? {} : input.path;
    const query = input.query === undefined ? {} : input.query;
    if (!isRecord(path)) throw new RegistryError("invalid-input", "path must be an object", descriptor.operationId, "path");
    if (!isRecord(query)) throw new RegistryError("invalid-input", "query must be an object", descriptor.operationId, "query");
    assertJsonValue(path, "path");
    assertJsonValue(query, "query");
    validateSchema(descriptor.request.pathSchema, path, "path", descriptor.operationId);
    validateSchema(descriptor.request.querySchema, query, "query", descriptor.operationId);
    const bodySchema = descriptor.request.body;
    const bodyProvided = input.body !== undefined;
    if (!bodySchema) {
      if (bodyProvided) throw new RegistryError("invalid-input", "body is not accepted", descriptor.operationId, "body");
    } else if (!bodyProvided) {
      if (bodySchema.required) throw new RegistryError("invalid-input", "body is required", descriptor.operationId, "body");
    } else {
      const body = input.body;
      if (body === undefined) throw new RegistryError("invalid-input", "body is required", descriptor.operationId, "body");
      assertJsonValue(body, "body");
      validateSchema(bodySchema.schema, body, "body", descriptor.operationId);
      if (descriptor.mediaType.request?.split(";", 1)[0]?.trim().toLowerCase() === "multipart/form-data") validateMultipartBody(body, descriptor.operationId);
      return { path: clone(path), query: clone(query), body: clone(body) };
    }
    return { path: clone(path), query: clone(query) };
  }
}

export const operationRegistry = new OperationRegistry();
export const getOperation = (operationId: string): OperationDescriptor | undefined => operationRegistry.getOperation(operationId);
export const lookupOperation = (operationId: string): OperationAdapter | undefined => operationRegistry.lookup(operationId);
export const listOperations = (filter?: OperationListFilter): readonly OperationAdapter[] => operationRegistry.listOperations(filter);
export const listCategories = (): readonly string[] => operationRegistry.listCategories();
export const validateOperation = (operationId: string, input: unknown): ValidatedOperationInput => operationRegistry.validateOperation(operationId, input);
export const operationIds = (): readonly string[] => listOperations().map((adapter) => adapter.descriptor.operationId);
export const validateOperationPayload = (operationId: string, input: unknown): ValidatedOperationInput => operationRegistry.validateOperation(operationId, input);
