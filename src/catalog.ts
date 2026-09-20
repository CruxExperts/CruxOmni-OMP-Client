import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { inspectSellerPrice, type PriceInspection, type ScalarCosts, type SellerPricing } from "./pricing.ts";

type JsonRecord = Record<string, unknown>;

export type EndpointApi = "openai-responses" | "openai-completions";

export interface CatalogDiagnostic {
	code: string;
	modelId?: string;
	detail?: string;
}

export interface CatalogProjection {
	/** Rows accepted from the authoritative /v1/models response, keyed by identity. */
	rows: ReadonlyMap<string, JsonRecord>;
	/** OMP-selectable models. Specialty-only rows are deliberately omitted. */
	models: readonly ProviderModelConfig[];
	/** Exact pricing projection used for each accepted identity. */
	pricing: ReadonlyMap<string, PriceInspection>;
	diagnostics: readonly CatalogDiagnostic[];
	counts: { known: number; unknown: number; conditional: number; stale: number };
}

export interface CatalogOptions {
	metadata?: unknown;
	pricing?: SellerPricing;
	pricingCurrent?: boolean;
	now?: number;
	stale?: boolean;
}

export class CatalogError extends Error {
	readonly code: string;
	constructor(code: string, detail?: string) {
		super(detail ? `${code}:${detail}` : code);
		this.name = "CatalogError";
		this.code = code;
	}
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const RESPONSE_NAMES: Record<string, true> = {
	responses: true,
	"openai-responses": true,
	"openai-responses-compatible": true,
	openai_responses: true,
	response: true,
};
const CHAT_NAMES: Record<string, true> = {
	chat: true,
	completions: true,
	"chat-completions": true,
	"openai-completions": true,
	"openai-chat-completions": true,
	"openai-chat-completions-compatible": true,
	openai_completions: true,
};
const SPECIALTY_NAMES = /(?:image|audio|embedding|moderation|transcri|speech|video|rerank|search)/i;

function record(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Stable comparison for duplicate identities; object key order is irrelevant. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function stringList(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.flatMap(item => {
		if (typeof item === "string") return [item];
		if (record(item)) {
			for (const key of ["name", "type", "id", "api", "format", "endpoint", "route"]) {
				if (typeof item[key] === "string") return [item[key] as string];
			}
		}
		return [];
	});
}

function endpointNames(row: JsonRecord): string[] {
	const names: string[] = [];
	for (const key of ["supported_endpoints", "supportedEndpoints", "endpoints", "endpoint", "api_format", "apiFormat", "format", "api"]) {
		const value = row[key];
		if (record(value)) {
			for (const [name, enabled] of Object.entries(value)) if (enabled !== false && enabled !== null) names.push(name);
		} else names.push(...stringList(value));
	}
	return names.map(name => name.trim().toLowerCase()).filter(Boolean);
}

function endpointFor(row: JsonRecord): { api?: EndpointApi; explicit: boolean; specialty: boolean } {
	const names = endpointNames(row);
	const hasResponses = names.some(name => RESPONSE_NAMES[name] === true || name.includes("responses"));
	const hasChat = names.some(name => CHAT_NAMES[name] === true || (name.includes("chat") && name.includes("completion")));
	if (hasResponses) return { api: "openai-responses", explicit: true, specialty: false };
	if (hasChat) return { api: "openai-completions", explicit: true, specialty: false };
	// Older /v1/models payloads omit endpoint metadata. Preserve the provider's
	// Responses-compatible default rather than making an otherwise valid row
	// disappear. Non-empty unknown endpoint metadata remains diagnostic-only.
	if (names.length === 0) return { api: "openai-responses", explicit: false, specialty: false };
	return { explicit: true, specialty: names.some(name => SPECIALTY_NAMES.test(name)) };
}

function catalogRows(metadata: unknown): Map<string, Map<string, JsonRecord>> {
	const result = new Map<string, Map<string, JsonRecord>>();
	if (!record(metadata) || !record(metadata.catalog)) return result;
	for (const [owner, provider] of Object.entries(metadata.catalog)) {
		const entries = record(provider) && Array.isArray(provider.models) ? provider.models : Array.isArray(provider) ? provider : [];
		const rows = new Map<string, JsonRecord>();
		for (const item of entries) {
			if (!record(item) || typeof item.id !== "string" || !item.id.trim()) continue;
			const old = rows.get(item.id);
			if (old && canonical(old) !== canonical(item)) throw new CatalogError("duplicate_identity_conflict");
			rows.set(item.id, item);
		}
		result.set(owner, rows);
	}
	return result;
}

function enrich(row: JsonRecord, metadata: Map<string, Map<string, JsonRecord>>): JsonRecord {
	const owner = typeof row.owned_by === "string" ? row.owned_by : undefined;
	const id = typeof row.id === "string" ? row.id : undefined;
	const extra = owner && id ? metadata.get(owner)?.get(id) : undefined;
	if (!extra) return row;
	return {
		...row,
		capabilities: record(row.capabilities) ? row.capabilities : extra.capabilities,
		context_length: positiveNumber(row.context_length) ?? positiveNumber(row.contextWindow) ?? positiveNumber(extra.context_length) ?? positiveNumber(extra.contextWindow),
		max_output_tokens: positiveNumber(row.max_output_tokens) ?? positiveNumber(row.maxTokens) ?? positiveNumber(extra.max_output_tokens) ?? positiveNumber(extra.maxTokens),
		input_modalities: Array.isArray(row.input_modalities) ? row.input_modalities : extra.input_modalities,
	};
}

function providerModel(row: JsonRecord, costs: ScalarCosts, metadata: JsonRecord | undefined, stale: boolean, endpoint: EndpointApi): ProviderModelConfig {
	const caps = record(row.capabilities) ? row.capabilities : {};
	const contextWindow = positiveNumber(row.context_length) ?? positiveNumber(row.contextWindow) ?? positiveNumber(metadata?.context_length) ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = positiveNumber(row.max_output_tokens) ?? positiveNumber(row.maxTokens) ?? positiveNumber(metadata?.max_output_tokens) ?? Math.min(DEFAULT_MAX_TOKENS, contextWindow);
	const modalities = Array.isArray(row.input_modalities) ? row.input_modalities : Array.isArray(metadata?.input_modalities) ? metadata.input_modalities : [];
	const model: ProviderModelConfig = {
		id: row.id as string,
		name: typeof row.name === "string" && row.name.trim() ? row.name : row.id as string,
		api: endpoint,
		reasoning: caps.reasoning === true || caps.thinking === true || row.reasoning === true || row.thinking === true,
		input: modalities.includes("image") ? ["text", "image"] : ["text"],
		contextWindow,
		maxTokens,
		cost: costs,
	};
	if (stale) model.name = `${model.name} (stale)`;
	return model;
}

/**
 * Project a bounded /v1/models payload. Runtime rows are never manufactured
 * from management catalog entries; metadata can only enrich an exact owner/id.
 */
export function projectCatalog(payload: unknown, options: CatalogOptions = {}): CatalogProjection {
	if (!record(payload) || !Array.isArray(payload.data)) throw new CatalogError("invalid_live_data");
	const metadata = catalogRows(options.metadata);
	const rows = new Map<string, JsonRecord>();
	const signatures = new Map<string, string>();
	const diagnostics: CatalogDiagnostic[] = [];
	const pricing = new Map<string, PriceInspection>();
	const models: ProviderModelConfig[] = [];
	const counts = { known: 0, unknown: 0, conditional: 0, stale: 0 };
	let malformed = 0;
	let duplicates = 0;
	for (const raw of payload.data) {
		if (!record(raw) || typeof raw.id !== "string" || !raw.id.trim()) {
			malformed++;
			continue;
		}
		const signature = canonical(raw);
		const prior = signatures.get(raw.id);
		if (prior !== undefined) {
			if (prior !== signature) throw new CatalogError("duplicate_identity_conflict");
			duplicates++;
			continue;
		}
		signatures.set(raw.id, signature);
		const enriched = enrich(raw, metadata);
		const endpoint = endpointFor(enriched);
		if (!endpoint.api) {
			diagnostics.push({ code: endpoint.specialty ? "specialty_only_route" : "unsupported_endpoint", modelId: raw.id });
			rows.set(raw.id, raw);
			continue;
		}
		const inspection = inspectSellerPrice(raw, options.pricing, options.pricingCurrent === true, options.now);
		pricing.set(raw.id, inspection);
		counts[inspection.state]++;
		const owner = typeof raw.owned_by === "string" ? raw.owned_by : undefined;
		models.push(providerModel(enriched, inspection.cost, owner ? metadata.get(owner)?.get(raw.id) : undefined, options.stale === true, endpoint.api));
		rows.set(raw.id, raw);
		if (!endpoint.explicit) diagnostics.push({ code: "endpoint_unverified_default", modelId: raw.id });
	}
	if (malformed) diagnostics.push({ code: "malformed_rows", detail: String(malformed) });
	if (duplicates) diagnostics.push({ code: "duplicate_rows", detail: String(duplicates) });
	return { rows, models, pricing, diagnostics, counts };
}

export const normalizeCatalog = projectCatalog;
export const toProviderModels = projectCatalog;

export const parseCatalog = projectCatalog;