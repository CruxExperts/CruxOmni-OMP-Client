import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ReleaseEligibilityStatus = "verified" | "unavailable";

export interface OperationEligibilitySource {
  readonly file: string;
  readonly sha256: string;
  readonly gitBlobSha: string;
}

export interface OperationEligibilityEvidence {
  readonly kind: string;
  readonly detail: string;
}

export interface OperationEligibilityResponseProperty {
  readonly type: "string";
  readonly enum?: readonly string[];
  readonly format?: "date-time";
}

export interface OperationEligibilityResponse {
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, OperationEligibilityResponseProperty>>;
}

export interface OperationEligibilityRecord {
  readonly operationId: string;
  readonly status: ReleaseEligibilityStatus;
  readonly reason: string;
  readonly source?: OperationEligibilitySource;
  readonly evidence?: readonly OperationEligibilityEvidence[];
  readonly response?: OperationEligibilityResponse;
}

interface EligibilityDocument {
  readonly default: { readonly status: "unavailable"; readonly reason: string };
  readonly operations: readonly OperationEligibilityRecord[];
}

const DEFAULT_REASON = "No exact pinned-source and behavior evidence is recorded for this operation in the release eligibility contract.";

function unavailable(operationId: string, reason = DEFAULT_REASON): OperationEligibilityRecord {
  return { operationId, status: "unavailable", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}

function parseRecord(value: unknown): OperationEligibilityRecord | undefined {
  if (!isRecord(value) || typeof value.operationId !== "string" || value.operationId.length === 0) return undefined;
  if (value.status === "unavailable") {
    return typeof value.reason === "string" && value.reason.length > 0
      ? { operationId: value.operationId, status: "unavailable", reason: value.reason }
      : undefined;
  }
  if (value.status !== "verified" || typeof value.reason !== "string" || value.reason.length === 0) return undefined;
  const source = value.source;
  const evidence = value.evidence;
  if (!isRecord(source) || typeof source.file !== "string" || !isSha(source.sha256, 64) || !isSha(source.gitBlobSha, 40)) return undefined;
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.some(item => !isRecord(item) || typeof item.kind !== "string" || item.kind.length === 0 || typeof item.detail !== "string" || item.detail.length === 0)) return undefined;
  const rawResponse = value.response;
  let response: OperationEligibilityResponse | undefined;
  if (rawResponse !== undefined) {
    if (!isRecord(rawResponse) || !Array.isArray(rawResponse.required) || !isRecord(rawResponse.properties)) return undefined;
    const properties: Record<string, OperationEligibilityResponseProperty> = {};
    for (const [name, property] of Object.entries(rawResponse.properties)) {
      if (!isRecord(property) || property.type !== "string" || (property.enum !== undefined && (!Array.isArray(property.enum) || property.enum.some(item => typeof item !== "string"))) || (property.format !== undefined && property.format !== "date-time")) return undefined;
      properties[name] = {
        type: "string",
        ...(property.enum === undefined ? {} : { enum: property.enum as string[] }),
        ...(property.format === undefined ? {} : { format: "date-time" as const }),
      };
    }
    if (rawResponse.required.some(item => typeof item !== "string") || rawResponse.required.some(item => !Object.prototype.hasOwnProperty.call(properties, item))) return undefined;
    response = { required: rawResponse.required as string[], properties };
  }
  return {
    operationId: value.operationId,
    status: "verified",
    reason: value.reason,
    source: { file: source.file, sha256: source.sha256, gitBlobSha: source.gitBlobSha },
    evidence: evidence.map(item => ({ kind: String(item.kind), detail: String(item.detail) })),
    ...(response === undefined ? {} : { response }),
  };
}

function loadDocument(): EligibilityDocument {
  const path = resolve(import.meta.dir, "../../contracts/release-eligibility.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.default) || parsed.default.status !== "unavailable" || typeof parsed.default.reason !== "string" || parsed.default.reason.length === 0 || !Array.isArray(parsed.operations)) {
      return { default: { status: "unavailable", reason: DEFAULT_REASON }, operations: [] };
    }
    const operations = parsed.operations.map(parseRecord);
    if (operations.some(item => item === undefined)) return { default: { status: "unavailable", reason: DEFAULT_REASON }, operations: [] };
    return { default: { status: "unavailable", reason: parsed.default.reason }, operations: operations as OperationEligibilityRecord[] };
  } catch {
    return { default: { status: "unavailable", reason: DEFAULT_REASON }, operations: [] };
  }
}

const DOCUMENT = loadDocument();

export interface EligibilityOptions {
  readonly records?: readonly OperationEligibilityRecord[];
}

export function createEligibilityIndex(options: EligibilityOptions = {}): ReadonlyMap<string, OperationEligibilityRecord> {
  const records = options.records ?? DOCUMENT.operations;
  const index = new Map<string, OperationEligibilityRecord>();
  for (const record of records) {
    if (!record.operationId) continue;
    if (index.has(record.operationId)) {
      index.set(record.operationId, unavailable(record.operationId, "Eligibility contract contains duplicate records for this operation."));
      continue;
    }
    index.set(record.operationId, structuredClone(record));
  }
  return index;
}

export function eligibilityFor(
  operationId: string,
  index: ReadonlyMap<string, OperationEligibilityRecord>,
  defaultReason = DOCUMENT.default.reason,
): OperationEligibilityRecord {
  return index.get(operationId) ?? unavailable(operationId, defaultReason);
}

export function isVerifiedEligibility(record: OperationEligibilityRecord, source: OperationEligibilitySource): boolean {
  return record.status === "verified"
    && record.source?.file === source.file
    && record.source.sha256 === source.sha256
    && record.source.gitBlobSha === source.gitBlobSha
    && (record.evidence?.length ?? 0) > 0;
}
