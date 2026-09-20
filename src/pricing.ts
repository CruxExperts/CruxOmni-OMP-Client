import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

type JsonRecord = Record<string, unknown>;
export type PriceState = "known" | "unknown" | "conditional" | "stale";
export interface ScalarCosts { input: number; output: number; cacheRead: number; cacheWrite: number }
interface Source {
	source_id: string;
	source_url: string;
	last_success_at: string | null;
	expires_at: string | null;
	snapshot_sha256: string | null;
	last_error_code: string | null;
}
interface Rate {
	seller_id: string;
	product: string;
	model_key: string;
	native_model_id: string | null;
	meter: string;
	unit: string;
	currency: string;
	amount: string | null;
	conditions: JsonRecord;
	basis: string;
	rate_state: string;
	source_id: string;
	snapshot_sha256: string;
	source_locator: string;
}
export interface SellerPricing {
	generatedAt: string;
	sources: Map<string, Source>;
	ownerAliases: Map<string, string>;
	routeProducts: Map<string, string | null>;
	rates: Map<string, Rate[]>;
	terms: JsonRecord[];
	unmappedRates: number;
}
export interface PriceInspection {
	state: PriceState;
	cost: ScalarCosts;
	fields: Record<keyof ScalarCosts, PriceState>;
	seller?: string;
	product?: string;
	nativeId?: string;
	reasons: string[];
	sourceUrls: string[];
	rates: Rate[];
}
const LIMIT = 8 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const METERS: Record<keyof ScalarCosts, string> = { input: "input", output: "output", cacheRead: "cache_read", cacheWrite: "cache_write" };
export const PRICING_WARNING = "OMP numeric totals omit unknown or conditional prices; use model_pricing estimate for source-backed scenarios.";

function record(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validateTree(value: unknown, depth = 0): void {
	if (depth > 24) throw new Error("pricing_depth_exceeded");
	if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new Error("pricing_invalid_number");
	if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
		if (/^(?:api[_-]?key|authorization|password|secret|account|account_id|balance|remaining_allowance|usage_history|email)$/i.test(key)) throw new Error("pricing_private_payload");
		validateTree(child, depth + 1);
	}
}
function canonicalAscii(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalAscii).join(",")}]`;
	if (record(value)) return `{${Object.keys(value).sort().map(key => `${canonicalAscii(key)}:${canonicalAscii(value[key])}`).join(",")}}`;
	return JSON.stringify(value).replace(/[\u0080-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function timestamp(value: unknown): value is string {
	return typeof value === "string" && /(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value));
}
function sourceRecord(value: unknown): value is Source {
	if (!record(value) || typeof value.source_id !== "string" || typeof value.source_url !== "string") return false;
	if (value.last_error_code !== null && typeof value.last_error_code !== "string") return false;
	if (value.last_success_at === null) return value.expires_at === null && value.snapshot_sha256 === null;
	return timestamp(value.last_success_at) && timestamp(value.expires_at)
		&& Date.parse(value.expires_at) - Date.parse(value.last_success_at) === 86400000
		&& typeof value.snapshot_sha256 === "string" && HASH.test(value.snapshot_sha256);
}
function rateRecord(value: unknown): value is Rate {
	if (!record(value) || !record(value.conditions)) return false;
	if (!["seller_id", "product", "model_key", "meter", "unit", "currency", "source_id", "snapshot_sha256", "source_locator"].every(key => typeof value[key] === "string" && value[key] !== "")) return false;
	return (value.native_model_id === null || typeof value.native_model_id === "string")
		&& (value.amount === null || typeof value.amount === "string" && DECIMAL.test(value.amount))
		&& ["cash", "allowance", "reference"].includes(String(value.basis))
		&& ["known", "unknown", "conflicting", "conditional"].includes(String(value.rate_state));
}

export async function readSellerPricing(path: string, now = Date.now()): Promise<SellerPricing> {
	const file = await open(path, "r");
	let body: unknown;
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > LIMIT) throw new Error("pricing_body_limit_exceeded");
		const buffer = Buffer.allocUnsafe(stat.size + 1);
		let count = 0;
		while (count < buffer.length) {
			const { bytesRead } = await file.read(buffer, count, buffer.length - count, null);
			if (!bytesRead) break;
			count += bytesRead;
		}
		if (count !== stat.size) throw new Error("pricing_file_changed");
		body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count)));
	} finally { await file.close(); }
	validateTree(body);
	if (!record(body) || body.kind !== "omp_seller_pricing" || body.schema_version !== 1 || !timestamp(body.generated_at) || Date.parse(body.generated_at) > now + 300000) throw new Error("pricing_schema_invalid");
	const { content_sha256: expected, ...content } = body;
	if (typeof expected !== "string" || !HASH.test(expected) || createHash("sha256").update(canonicalAscii(content)).digest("hex") !== expected) throw new Error("pricing_digest_invalid");
	if (!Array.isArray(body.sources) || !Array.isArray(body.rates) || !Array.isArray(body.terms) || !Array.isArray(body.exact_mappings) || !record(body.owner_aliases) || !record(body.route_products)) throw new Error("pricing_schema_invalid");
	const view: SellerPricing = { generatedAt: body.generated_at, sources: new Map(), ownerAliases: new Map(), routeProducts: new Map(), rates: new Map(), terms: [], unmappedRates: 0 };
	for (const source of body.sources) {
		if (!sourceRecord(source) || view.sources.has(source.source_id) || source.last_success_at && Date.parse(source.last_success_at) > now + 300000) throw new Error("pricing_source_invalid");
		const url = new URL(source.source_url);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("pricing_source_url_invalid");
		view.sources.set(source.source_id, source);
	}
	for (const [owner, seller] of Object.entries(body.owner_aliases)) {
		if (typeof seller !== "string" || !seller) throw new Error("pricing_owner_invalid");
		view.ownerAliases.set(owner, seller);
	}
	for (const [owner, product] of Object.entries(body.route_products)) {
		if (product !== null && (typeof product !== "string" || !product)) throw new Error("pricing_product_invalid");
		view.routeProducts.set(owner, product);
	}
	const mappings = new Map<string, string>();
	for (const mapping of body.exact_mappings) {
		if (!record(mapping) || !["seller_id", "product", "model_key", "native_model_id"].every(key => typeof mapping[key] === "string" && mapping[key] !== "")) throw new Error("pricing_mapping_invalid");
		const key = JSON.stringify([mapping.seller_id, mapping.product, mapping.model_key]);
		if (mappings.has(key) && mappings.get(key) !== mapping.native_model_id) throw new Error("pricing_mapping_conflict");
		mappings.set(key, String(mapping.native_model_id));
	}
	for (const raw of body.rates) {
		if (!rateRecord(raw) || view.sources.get(raw.source_id)?.snapshot_sha256 !== raw.snapshot_sha256) throw new Error("pricing_rate_invalid");
		const mapped = mappings.get(JSON.stringify([raw.seller_id, raw.product, raw.model_key]));
		if (raw.native_model_id !== null && mapped && raw.native_model_id !== mapped) throw new Error("pricing_mapping_conflict");
		const native = raw.native_model_id ?? mapped;
		if (!native) { view.unmappedRates++; continue; }
		const key = JSON.stringify([raw.seller_id, raw.product, native]);
		const rows = view.rates.get(key);
		if (rows) rows.push(raw); else view.rates.set(key, [raw]);
	}
	for (const value of body.terms) {
		if (!record(value) || typeof value.source_id !== "string" || typeof value.seller_id !== "string" || typeof value.product !== "string" || typeof value.plan_key !== "string" || typeof value.term_key !== "string" || view.sources.get(value.source_id)?.snapshot_sha256 !== value.snapshot_sha256) throw new Error("pricing_term_invalid");
		view.terms.push(value);
	}
	return view;
}

export function inspectSellerPrice(row: JsonRecord, view: SellerPricing | undefined, fileCurrent: boolean, now = Date.now()): PriceInspection {
	const result: PriceInspection = { state: "unknown", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, fields: { input: "unknown", output: "unknown", cacheRead: "unknown", cacheWrite: "unknown" }, reasons: [], sourceUrls: [], rates: [] };
	const owner = typeof row.owned_by === "string" ? row.owned_by : "";
	const id = typeof row.id === "string" ? row.id : "";
	if (!view) { result.reasons.push("seller_projection_unavailable"); return result; }
	if (owner === "combo" || row.type === "combo" || row.is_combo === true) { result.reasons.push("dynamic_combo_price_unknown"); return result; }
	const seller = view.ownerAliases.get(owner);
	const product = view.routeProducts.get(owner) ?? undefined;
	if (seller !== undefined) result.seller = seller;
	if (product !== undefined) result.product = product;
	if (!seller || !product) { result.reasons.push(seller ? "billing_product_not_established" : "unsupported_seller"); return result; }
	let native = id;
	let rows = view.rates.get(JSON.stringify([result.seller, result.product, native]));
	if (!rows && id.startsWith(`${owner}/`)) {
		native = id.slice(owner.length + 1);
		rows = view.rates.get(JSON.stringify([result.seller, result.product, native]));
	}
	if (!rows) { result.reasons.push("exact_native_price_unavailable"); return result; }
	result.nativeId = native;
	result.rates = rows;
	result.sourceUrls = [...new Set(rows.map(rate => view.sources.get(rate.source_id)!.source_url))];
	if (!fileCurrent) { result.reasons.push("pricing_file_failure_retained_view_for_inspection_only"); return result; }
	for (const [field, meter] of Object.entries(METERS) as [keyof ScalarCosts, string][]) {
		const candidates = rows.filter(rate => rate.meter === meter);
		if (!candidates.length) continue;
		if (candidates.some(rate => {
			const source = view.sources.get(rate.source_id)!;
			return source.last_error_code !== null || !source.expires_at || now >= Date.parse(source.expires_at);
		})) { result.fields[field] = "stale"; continue; }
		if (candidates.some(rate => rate.basis !== "cash" || rate.rate_state === "conditional" || Object.keys(rate.conditions).length !== 0)) { result.fields[field] = "conditional"; continue; }
		if (candidates.some(rate => rate.rate_state !== "known" || rate.currency !== "USD" || rate.amount === null || !["million_tokens", "token"].includes(rate.unit))) continue;
		const amounts = new Set(candidates.map(rate => Number(rate.amount) * (rate.unit === "token" ? 1000000 : 1)));
		const amount = amounts.values().next().value;
		if (amounts.size === 1 && amount !== undefined && Number.isFinite(amount) && amount >= 0) {
			result.fields[field] = "known";
			result.cost[field] = amount;
		}
	}
	const states = Object.values(result.fields);
	result.state = states.includes("stale") ? "stale" : states.includes("conditional") ? "conditional" : states.every(state => state === "known") ? "known" : "unknown";
	if (result.state !== "known") result.reasons.push("non_known_fields_use_numeric_compatibility_zero");
	return result;
}
