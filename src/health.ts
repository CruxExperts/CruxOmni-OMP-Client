import type { CatalogProjection } from "./catalog.ts";

export type HealthState = "unconfigured" | "ready" | "degraded" | "offline" | "unauthorized";

export interface DiscoveryBinding {
	endpoint: string;
	credential: string;
	generation: number;
}

export interface HealthSnapshot {
	state: HealthState;
	generation: number;
	modelCount: number;
	stale: boolean;
	lastError?: string;
}

export interface DiscoveryResult {
	projection: CatalogProjection;
	stale?: boolean;
}

export type DiscoverFn = (binding: DiscoveryBinding, signal: AbortSignal) => Promise<DiscoveryResult>;
export type HealthListener = (snapshot: HealthSnapshot) => void;

interface ClassifiedError {
	state: Exclude<HealthState, "unconfigured" | "ready">;
	code: string;
}

function errorCode(error: unknown): string {
	if (error && typeof error === "object") {
		const value = error as { code?: unknown; status?: unknown };
		if (typeof value.code === "string" && /^[a-z][a-z0-9_-]*$/.test(value.code)) return value.code;
		if (typeof value.status === "number" && Number.isInteger(value.status)) return `http_${value.status}`;
	}
	return "request_failed";
}

function classify(error: unknown): ClassifiedError {
	const code = errorCode(error);
	const status = error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number"
		? (error as { status: number }).status : undefined;
	if (status === 401 || status === 403 || code === "http_401" || code === "http_403" || code === "unauthorized") return { state: "unauthorized", code };
	if ([408, 429, 502, 503, 504].includes(status ?? -1) || ["request_timeout", "request_aborted", "network_error", "connection_refused", "offline", "http_408", "http_429", "http_502", "http_503", "http_504", "timeout", "aborted", "network", "body-read", "budget-exhausted"].includes(code)) return { state: "offline", code };
	return { state: "degraded", code };
}
function staleProjection(projection: CatalogProjection): CatalogProjection {
	const models = projection.models.map(model =>
		model.name.endsWith(" (stale)") ? model : { ...model, name: `${model.name} (stale)` },
	);
	return { ...projection, models };
}


/**
 * Owns generation cancellation and the only model-discovery single-flight.
 * It deliberately stores successful rows in memory only; a new manager starts
 * without a selectable offline catalog.
 */
export class DiscoveryManager {
	private binding: DiscoveryBinding | undefined;
	private sourceGeneration: number | undefined;
	private generation = 0;
	private stopped = false;
	private flight: Promise<DiscoveryResult | undefined> | undefined;
	private aborter: AbortController | undefined;
	private lastGood: DiscoveryResult | undefined;
	private snapshot: HealthSnapshot = { state: "unconfigured", generation: 0, modelCount: 0, stale: false };
	private readonly listeners = new Set<HealthListener>();

	constructor(private readonly discover: DiscoverFn, listeners?: Iterable<HealthListener>) {
		if (listeners) for (const listener of listeners) this.listeners.add(listener);
	}

	addListener(listener: HealthListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get status(): HealthSnapshot {
		return { ...this.snapshot };
	}

	get currentBinding(): DiscoveryBinding | undefined {
		return this.binding && { ...this.binding };
	}

	/** Start a new auth/endpoint generation and cancel all old network work. */
	setBinding(endpoint: string | undefined, credential: string | undefined, generation?: number): void {
		const normalizedEndpoint = endpoint?.trim();
		const normalizedCredential = credential?.trim();
		const changed = normalizedEndpoint !== this.binding?.endpoint || normalizedCredential !== this.binding?.credential;
		const generationChanged = generation !== undefined && generation !== this.sourceGeneration;
		if (!changed && !generationChanged) return;
		this.aborter?.abort();
		this.aborter = undefined;
		this.flight = undefined;
		this.sourceGeneration = generation;
		this.generation = generation === undefined ? this.generation + 1 : Math.max(this.generation + 1, generation);
		if (!normalizedEndpoint || !normalizedCredential) {
			this.binding = undefined;
			this.lastGood = undefined;
			this.setSnapshot({ state: "unconfigured", generation: this.generation, modelCount: 0, stale: false });
			return;
		}
		this.binding = { endpoint: normalizedEndpoint, credential: normalizedCredential, generation: this.generation };
		if (changed || generationChanged) {
			this.lastGood = undefined;
			this.setSnapshot({ state: "degraded", generation: this.generation, modelCount: 0, stale: false });
		}
	}

	/** Clear the binding and all source-owned rows on shutdown/reconfiguration. */
	reset(): void {
		this.aborter?.abort();
		this.aborter = undefined;
		this.sourceGeneration = undefined;
		this.binding = undefined;
		this.lastGood = undefined;
		this.generation++;
		this.setSnapshot({ state: "unconfigured", generation: this.generation, modelCount: 0, stale: false });
	}

	async refresh(): Promise<DiscoveryResult | undefined> {
		if (this.stopped) return undefined;
		const binding = this.binding;
		if (!binding) {
			this.setSnapshot({ state: "unconfigured", generation: this.generation, modelCount: 0, stale: false });
			return undefined;
		}
		if (this.flight) return this.flight;
		const generation = this.generation;
		const controller = new AbortController();
		this.aborter = controller;
		const request = this.discover(binding, controller.signal).then(result => {
			if (this.stopped || generation !== this.generation || this.binding?.generation !== generation) return undefined;
			this.lastGood = { projection: result.projection, stale: false };
			const count = result.projection.models.length;
			this.setSnapshot({ state: "ready", generation, modelCount: count, stale: false });
			return { projection: result.projection, stale: false };
		}).catch(error => {
			const failure = classify(error);
			// A cancelled or superseded request is not a discovery failure for
			// the active generation; discard its late result quietly.
			if (this.stopped || generation !== this.generation || this.binding?.generation !== generation) return undefined;
			const retained = this.lastGood;
			if (retained) {
				const projection = staleProjection(retained.projection);
				this.setSnapshot({ state: failure.state, generation, modelCount: projection.models.length, stale: true, lastError: failure.code });
				return { projection, stale: true };
			}
			this.setSnapshot({ state: failure.state, generation, modelCount: 0, stale: false, lastError: failure.code });
			throw error;
		}).finally(() => {
			if (this.flight === request) this.flight = undefined;
			if (this.aborter === controller) this.aborter = undefined;
		});
		this.flight = request;
		return request;
	}

	shutdown(): void {
		this.stopped = true;
		this.aborter?.abort();
		this.aborter = undefined;
		this.flight = undefined;
		this.binding = undefined;
		this.lastGood = undefined;
	}

	resume(): void {
		this.stopped = false;
	}

	private setSnapshot(snapshot: HealthSnapshot): void {
		const previous = this.snapshot;
		this.snapshot = snapshot;
		if (previous.state === snapshot.state) return;
		for (const listener of this.listeners) {
			try { listener({ ...snapshot }); } catch { /* diagnostics must not break discovery */ }
		}
	}
}

export { DiscoveryManager as ProviderHealth };

export function createDiscoveryManager(discover: DiscoverFn, listener?: HealthListener): DiscoveryManager {
	return new DiscoveryManager(discover, listener ? [listener] : undefined);
}
