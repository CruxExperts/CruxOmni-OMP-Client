import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { DISPLAY_NAME, PACKAGE_NAME } from "./identity.ts";
import { OptionalCredentials } from "./credentials.ts";
import { createSetupWizard } from "./setup.ts";
import { registerNativeLogin, recoverPendingAfterPersistence, resolveRuntimeCredential } from "./auth.ts";
import { type PluginConfig, loadConfig, resolveEnvironmentBinding, setAdminEnabledConfig, updateConfig } from "./config.ts";
import { projectCatalog, type CatalogOptions, type CatalogProjection } from "./catalog.ts";
import { DiscoveryManager, type DiscoveryBinding, type HealthSnapshot } from "./health.ts";
import { readSellerPricing, PRICING_WARNING, type SellerPricing } from "./pricing.ts";
import { requestJson, TransportError } from "./transport.ts";
import { adapterFor, invokeBinaryAdapter, invokeJsonAdapter, invokeMultipartAdapter, invokeSseAdapter, invokeWebSocketAdapter, type AdapterInvocation, type AdapterResponse, type MultipartFile, type AdminCredential as AdapterCredential } from "./admin/adapters.ts";
import { createAdminExecutor, type AdminExecutor } from "./admin/executor.ts";
import { registerAdminCommand, type AdminUiOptions } from "./admin/ui.ts";
import { registerAdminTools } from "./admin/tools.ts";
import { canonicalizeJson, listOperations, operationRegistry, type OperationAdapter, type OperationDescriptor } from "./admin/registry.ts";
import type { AdminDispatch, AdminReconcileContext, AdminRequest, AdminTargetReader, JsonObject } from "./admin/types.ts";
import { createBoundInferenceStream, OMNIROUTE_GUARDED_API } from "./inference.ts";

const PROVIDER_ID = "omniroute";
const RUNTIME_ENV = "OMP_OMNIROUTE_API_KEY";
const METADATA_ENV = "OMP_OMNIROUTE_METADATA_API_KEY";
const PRICING_ENV = "OMP_OMNIROUTE_PRICING_FILE";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 24;

type ContextLike = ExtensionContext;


function safeDetail(error: unknown): string {
	if (error instanceof TransportError) return error.code;
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z][a-z0-9_-]*$/.test(error.code)) return error.code;
	return "request_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function multipartParts(value: unknown): { files: MultipartFile[]; fields: Record<string, string> } {
	if (!isRecord(value)) return { files: [], fields: {} };
	const files: MultipartFile[] = [];
	const fields: Record<string, string> = {};
	const fileEntries = value.files;
	if (fileEntries !== undefined) {
		if (!Array.isArray(fileEntries)) throw new Error("multipart files must be an array");
		for (const entry of fileEntries) {
			if (!isRecord(entry) || typeof entry.field !== "string" || typeof entry.path !== "string") throw new Error("multipart file entry is invalid");
			const file: MultipartFile = { field: entry.field, path: entry.path };
			if (typeof entry.filename === "string") file.filename = entry.filename;
			if (typeof entry.contentType === "string") file.contentType = entry.contentType;
			files.push(file);
		}
	}
	const source = isRecord(value.fields) ? value.fields : value;
	for (const [key, child] of Object.entries(source)) {
		if (source === value && key === "files") continue;
		if (source === value && key === "fields") continue;
		if (isRecord(child) && Object.prototype.hasOwnProperty.call(child, "path")) {
			if (typeof child.path !== "string") throw new Error("multipart file path is invalid");
			const file: MultipartFile = { field: typeof child.field === "string" ? child.field : key, path: child.path };
			if (typeof child.filename === "string") file.filename = child.filename;
			if (typeof child.contentType === "string") file.contentType = child.contentType;
			files.push(file);
			continue;
		}
		fields[key] = typeof child === "string" ? child : JSON.stringify(child) ?? "";
	}
	return { files, fields };
}
async function invokeMultipartBody(invocation: AdapterInvocation, body: unknown): Promise<AdapterResponse> {
	const parts = multipartParts(body);
	return invokeMultipartAdapter(invocation, parts.files, parts.fields);
}
function scalarQuery(query: JsonObject): Record<string, string | number | boolean> {
	return Object.fromEntries(Object.entries(query).map(([key, value]) => [
		key,
		typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : canonicalizeJson(value),
	]));
}

function endpointRoot(endpoint: string): string {
	return endpoint.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function modelsUrl(endpoint: string): string {
	return `${endpointRoot(endpoint)}/v1/models`;
}

function baseApi(endpoint: string): string {
	return `${endpointRoot(endpoint)}/v1`;
}

function providerConfig(
	oauth: NonNullable<ProviderConfig["oauth"]>,
	endpoint?: string,
	models?: CatalogProjection["models"],
	fetchDynamicModels?: ProviderConfig["fetchDynamicModels"],
	apiKeyEnvironment?: string,
	streamSimple?: ProviderConfig["streamSimple"],
): ProviderConfig {
	const result: ProviderConfig = { oauth };
	if (endpoint) {
		result.baseUrl = baseApi(endpoint);
		result.api = streamSimple ? OMNIROUTE_GUARDED_API : "openai-responses";
		result.authHeader = true;
		if (apiKeyEnvironment) result.apiKey = apiKeyEnvironment;
		if (streamSimple) result.streamSimple = streamSimple;
	}
	if (models) result.models = [...models];
	if (fetchDynamicModels) result.fetchDynamicModels = fetchDynamicModels;
	return result;
}

function notify(context: ExtensionContext | undefined, text: string, type: "info" | "warning" | "error" = "info"): void {
	if (!context) return;
	const safe = text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2000);
	if (context.hasUI) context.ui.notify(safe, type);
	else process.stderr.write(`${safe}\n`);
}
function envBinding(allowInsecureHttp = false): { endpoint: string; credential: string; generation: number } | undefined {
	const key = process.env[RUNTIME_ENV]?.trim();
	const configuredUrl = process.env.OMP_OMNIROUTE_BASE_URL?.trim();
	if (!key && !configuredUrl) return undefined;
	const binding = resolveEnvironmentBinding({ allowInsecureHttp });
	if (!binding) return undefined;
	return { endpoint: binding.endpoint, credential: binding.credential.value, generation: binding.generation };
}

export default async function registerOmniRouteProvider(pi: ExtensionAPI): Promise<void> {
	let context: ContextLike | undefined;
	let stopped = false;
	let config: PluginConfig;
	try {
		config = await loadConfig();
	} catch (error) {
		const reason = safeDetail(error);
		pi.registerCommand("cruxomni", {
			description: `${DISPLAY_NAME} configuration diagnostics`,
			handler: async (_args, ctx) => notify(ctx, `${DISPLAY_NAME}: configuration blocked (${reason}). Repair the private omniroute/config.json in this OMP profile, then restart. No credentials or requests were sent.`, "warning"),
		});
		return;
	}
	let pricing: SellerPricing | undefined;
	const optionalCredentials = new OptionalCredentials();
	let metadataState = "not configured";
	let pricingCurrent = false;
	let latestProjection: CatalogProjection | undefined;
	let transitionNotifications = true;
	let pendingCandidateKey: string | undefined;
	let pendingCandidateEndpoint: string | undefined;
	const replaceProvider = (next: ProviderConfig): void => {
		pi.unregisterProvider(PROVIDER_ID);
		pi.registerProvider(PROVIDER_ID, next);
	};

	const onSetupComplete = async (endpoint: string, candidateKey: string): Promise<void> => {
		if (stopped) return;
		// Native AuthStorage has not necessarily persisted the returned key yet.
		// Keep the provider auth-only; manual refresh performs the pending
		// endpoint/key comparison after persistence.
		pendingCandidateEndpoint = endpoint;
		pendingCandidateKey = candidateKey;
		manager.reset();
		latestProjection = undefined;
		replaceProvider(providerConfig(oauth));
	};
	const nativeLogin = registerNativeLogin({ onSetupComplete });
	const oauth: NonNullable<ProviderConfig["oauth"]> = {
		name: nativeLogin.name,
		login: callbacks => nativeLogin.login({
			onPrompt: async options => callbacks.onPrompt({
				message: options.message,
				...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
				...(options.secret === undefined ? {} : { secret: options.secret }),
			}),
			onConfirm: async options => {
				const answer = await callbacks.onPrompt({
					message: `${options.message}${options.detail ? `\n${options.detail}` : ""}`,
					placeholder: "yes/no",
				});
				return /^(?:y|yes)$/i.test(answer.trim());
			},
			onMessage: message => callbacks.onProgress?.(message),
		}),
	};

	const loadPricing = async (file: string | undefined): Promise<void> => {
		pricingCurrent = false;
		if (!file) return;
		try {
			pricing = await readSellerPricing(file);
			pricingCurrent = true;
		} catch {
			// Keep the last parsed view for inspection, but never use it for
			// numeric totals while the current file is unavailable.
		}
	};
	const discover = async (binding: DiscoveryBinding, signal: AbortSignal) => {
		await loadPricing(config.pricingFile ?? process.env[PRICING_ENV]?.trim());
		const limits = { timeoutMs: 10_000, maxBytes: MAX_BODY_BYTES, maxDepth: MAX_JSON_DEPTH };
		const retry = { maxRetries: 1, safeRead: true, retryStatuses: [429, 502, 503, 504] as const };
		const livePromise = requestJson(modelsUrl(binding.endpoint), binding.credential, limits, signal, retry);
		const metadataKey = process.env[METADATA_ENV]?.trim() ?? (context ? await optionalCredentials.resolve("metadata", binding, context.modelRegistry.authStorage) : undefined)?.value;
		metadataState = metadataKey ? "checking" : "not configured";
		const metadataPromise = metadataKey
			? requestJson(`${endpointRoot(binding.endpoint)}/api/models/catalog`, metadataKey, { ...limits, timeoutMs: 5_000, totalBudgetMs: 5_000 }, signal, retry)
				.then(value => { metadataState = "available"; return value; }).catch(() => { metadataState = "unavailable"; return undefined; })
			: Promise.resolve(undefined);
		const [live, metadata] = await Promise.all([livePromise, metadataPromise]);
		const catalogOptions: CatalogOptions = {
			pricingCurrent,
			stale: false,
			...(metadata === undefined ? {} : { metadata }),
			...(pricing === undefined ? {} : { pricing }),
		};
		return { projection: projectCatalog(live, catalogOptions) };
	};

	const manager = new DiscoveryManager(discover, [snapshot => {
		if (!transitionNotifications || stopped || snapshot.state === "unconfigured") return;
		const kind = snapshot.state === "ready" ? "info" : snapshot.state === "unauthorized" ? "warning" : "error";
		notify(context, `omniroute: state ${snapshot.state}; models=${snapshot.modelCount}${snapshot.lastError ? `; detail=${snapshot.lastError}` : ""}`, kind);
	}]);
	const runtimeProviderConfig = (
		endpoint?: string,
		models?: CatalogProjection["models"],
	): ProviderConfig => {
		const environment = endpoint ? envBinding(config.allowInsecureHttp) : undefined;
		const modelApis = new Map((models ?? []).map(model => [model.id, model.api === "openai-completions" ? "openai-completions" as const : "openai-responses" as const]));
		const guardedModels = models?.map(model => ({ ...model, api: OMNIROUTE_GUARDED_API }));
		const expectedGeneration = manager.currentBinding?.generation ?? environment?.generation ?? config.active?.generation ?? 0;
		return providerConfig(
			oauth,
			endpoint,
			guardedModels,
			endpoint
				? async apiKey => {
					const credential = environment?.credential ?? apiKey;
					if (!credential) return [];
					const effectiveEndpoint = environment?.endpoint ?? endpoint;
					const generation = environment?.generation ?? config.pending?.generation ?? config.active?.generation ?? 0;
					const result = await discover(
						{ endpoint: effectiveEndpoint, credential, generation },
						AbortSignal.timeout(10_000),
					);
					latestProjection = result.projection;
					return result.projection.models;
				}
				: undefined,
			environment ? RUNTIME_ENV : undefined,
			endpoint && guardedModels ? createBoundInferenceStream({
				expectedEndpoint: endpoint,
				expectedGeneration,
				modelApis,
				currentBinding: () => manager.currentBinding,
				stopped: () => stopped,
			}) : undefined,
		);
	};
	let initialEndpoint: string | undefined;
	try {
		initialEndpoint = envBinding(config.allowInsecureHttp)?.endpoint
			?? (config.pending ? undefined : config.active?.endpoint);
	} catch {
		// Invalid environment bindings remain fail-closed and auth-only.
	}
	// Register dynamic discovery before OMP resolves a requested model. Waiting
	// for session_start is too late: model selection precedes session creation.
	replaceProvider(runtimeProviderConfig(initialEndpoint));
	const readAdapterFor = (operation: OperationDescriptor): OperationAdapter | undefined => {
		return listOperations({ method: "GET", sideEffect: "read", authDomain: operation.auth.domain })
			.find(adapter => adapter.descriptor.pathTemplate === operation.pathTemplate);
	};
	const adminDispatch: AdminDispatch = async (request, dispatchContext) => {
		const eligibility = operationRegistry.getEligibility(request.operation.operationId);
		if (eligibility.status !== "verified") throw new Error(`administration operation unavailable: ${eligibility.reason}`);
		const adapterId = request.operation.coverage.adapterId;
		if (request.operation.coverage.status !== "invokable" || adapterId === null) throw new Error("administration request is not invokable");
		const descriptor = { ...request.operation, adapterId };
		const credential: AdapterCredential | undefined = dispatchContext.credential.apiKey
			? { kind: "apiKey", value: dispatchContext.credential.apiKey }
			: dispatchContext.credential.cookie
				? { kind: "cookie", value: dispatchContext.credential.cookie }
				: undefined;
		const invocation: AdapterInvocation = {
			descriptor,
			endpoint: endpointRoot(dispatchContext.endpoint),
			...(credential === undefined ? {} : { credential }),
			resolvedPath: request.path,
			query: request.query,
			...(request.body === undefined ? {} : { body: request.body }),
			...(dispatchContext.signal === undefined ? {} : { signal: dispatchContext.signal }),
		};
		const kind = adapterFor(descriptor);
		if (kind === "operator-required") return { status: "operator-required", reason: "external-consent", message: "operator authorization is required for this external flow" };
		const result = kind === "binary"
			? await invokeBinaryAdapter(invocation)
			: kind === "sse"
				? await invokeSseAdapter(invocation)
				: kind === "websocket"
					? await invokeWebSocketAdapter(invocation)
					: kind === "multipart"
						? await invokeMultipartBody(invocation, request.body)
						: await invokeJsonAdapter(invocation);
		if (result.status >= 400) throw Object.assign(new Error("administration request failed"), { status: result.status });
		return result.data;
	};
	const readTarget: AdminTargetReader = async target => {
		const adapter = readAdapterFor(target.operation);
		if (!adapter) return { digest: "unavailable" };
		try {
			const input = adapter.validate({ path: target.payload.path, query: target.payload.query });
			const path = adapter.buildPath(input);
			const request: AdminRequest = {
				operationId: adapter.descriptor.operationId,
				method: adapter.descriptor.method,
				url: `${target.endpoint}${path}`,
				path,
				query: scalarQuery(input.query),
				operation: adapter.descriptor,
			};
			const value = await adminDispatch(request, {
				profileId: target.profileId,
				endpoint: target.endpoint,
				credential: target.credential,
				credentialGeneration: target.credentialGeneration,
				retryAllowed: true,
				maxAttempts: Math.min(2, adapter.descriptor.retry.maxAttempts),
				...(target.signal === undefined ? {} : { signal: target.signal }),
			});
			return { digest: createHash("sha256").update(canonicalizeJson(value)).digest("hex") };
		} catch {
			return { digest: "unavailable" };
		}
	};
	const reconcile = async (reconcileContext: AdminReconcileContext): Promise<unknown> => {
		const adapter = readAdapterFor(reconcileContext.operation);
		if (!adapter) return undefined;
		const { body: _body, ...requestWithoutBody } = reconcileContext.request;
		const readRequest: AdminRequest = {
			...requestWithoutBody,
			operationId: adapter.descriptor.operationId,
			method: adapter.descriptor.method,
			operation: adapter.descriptor,
		};
		return adminDispatch(readRequest, {
			...reconcileContext,
		});
	};
	const adminExecutor: AdminExecutor = createAdminExecutor({ dispatch: adminDispatch, readTarget, reconcile });
	const adminUiOptions: AdminUiOptions = {
		executor: adminExecutor,
		profileId: "omniroute",
	};
	const resolveEffectiveAdminEndpoint = async (): Promise<{ endpoint: string; credentialGeneration: number } | undefined> => {
		const current = await loadConfig();
		const environment = resolveEnvironmentBinding(current);
		if (environment) return { endpoint: environment.endpoint, credentialGeneration: environment.generation };
		if (current.active) return { endpoint: current.active.endpoint, credentialGeneration: current.active.generation };
		return undefined;
	};
	adminUiOptions.resolveEffectiveEndpoint = resolveEffectiveAdminEndpoint;
	adminUiOptions.onEnable = async endpoint => {
		const current = await loadConfig();
		const environment = resolveEnvironmentBinding(current);
		const effective = environment?.endpoint ?? current.active?.endpoint;
		if (!effective || effective !== endpoint) throw new Error("administration requires an already active exact endpoint");
		config = await setAdminEnabledConfig(true, current.revision === undefined ? undefined : { expectedRevision: current.revision });
		const active = resolveEnvironmentBinding(config) ?? config.active;
		if (!active) throw new Error("administration endpoint was not activated");
		adminUiOptions.endpoint = active.endpoint;
		adminUiOptions.credentialGeneration = active.generation;
		adminExecutor.setAdminBinding({ profileId: "omniroute", endpoint: active.endpoint, credentialGeneration: active.generation }, true);
		return { endpoint: active.endpoint, credentialGeneration: active.generation };
	};
	const syncAdminUiBinding = (source: PluginConfig): void => {
		if (!source.adminEnabled) {
			adminExecutor.clearAdminBinding();
			delete adminUiOptions.endpoint;
			delete adminUiOptions.credentialGeneration;
			return;
		}
		try {
			const environment = resolveEnvironmentBinding(source);
			const active = environment ?? source.active;
			if (active) {
				const credentialBinding = adminExecutor.getCredentialBinding();
				const administrationGeneration = credentialBinding?.profileId === "omniroute" && credentialBinding.endpoint === active.endpoint
					? credentialBinding.credentialGeneration : active.generation;
				adminUiOptions.endpoint = active.endpoint;
				adminUiOptions.credentialGeneration = administrationGeneration;
				adminExecutor.setAdminBinding({ profileId: "omniroute", endpoint: active.endpoint, credentialGeneration: administrationGeneration });
				return;
			}
		} catch {
			// Invalid environment bindings remain fail-closed.
		}
		delete adminUiOptions.endpoint;
		delete adminUiOptions.credentialGeneration;
		adminExecutor.clearAdminBinding();
	};
	const synchronizeAdministration = async (): Promise<void> => {
		try {
			config = await loadConfig();
			// Reconciliation always discards the prior in-memory secret first. A
			// missing, pending, revoked, failed, or replaced record can therefore
			// never inherit an older usable credential.
			adminExecutor.logout();
			syncAdminUiBinding(config);
			const effective = resolveEnvironmentBinding(config) ?? config.active;
			if (config.adminEnabled && effective) {
				adminExecutor.setAdminBinding({ profileId: "omniroute", endpoint: effective.endpoint, credentialGeneration: effective.generation }, true);
			}
			if (context && config.adminEnabled && !config.pending && !process.env.OMP_OMNIROUTE_ADMIN_API_KEY && !process.env.OMP_OMNIROUTE_ADMIN_COOKIE) {
				const active = effective;
				const saved = active ? await optionalCredentials.resolve("admin", active, context.modelRegistry.authStorage) : undefined;
				if (active && saved) adminExecutor.bindCredential({ profileId: "omniroute", endpoint: active.endpoint, credentialGeneration: active.generation,
					...(saved.kind === "cookie" ? { cookie: saved.value } : { apiKey: saved.value }) });
			}
		} catch {
			delete adminUiOptions.endpoint;
			delete adminUiOptions.credentialGeneration;
			adminExecutor.clearAdminBinding();
			throw new Error("administration configuration unavailable");
		}
	};
	adminUiOptions.syncBinding = synchronizeAdministration;
	adminUiOptions.onDisable = async () => {
		const current = await loadConfig();
		config = await setAdminEnabledConfig(false, current.revision === undefined ? undefined : { expectedRevision: current.revision });
		syncAdminUiBinding(config);
	};
	registerAdminCommand(pi, adminUiOptions);
	registerAdminTools(pi, { executor: adminExecutor, ui: adminUiOptions, syncBinding: synchronizeAdministration });
	const applyProjection = (projection: CatalogProjection): void => {
		const binding = manager.currentBinding;
		if (!binding || stopped) return;
		// Re-registering the source-owned model set is the only mutation path;
		latestProjection = projection;
		replaceProvider(runtimeProviderConfig(binding.endpoint, projection.models));
	};

	async function refresh(ctx: ContextLike, manual: boolean): Promise<void> {
		if (stopped) return;
		try {
			const previousAdminEndpoint = adminUiOptions.endpoint;
			const previousAdminGeneration = adminUiOptions.credentialGeneration;
			const previousAdminEnabled = config.adminEnabled;
			config = await loadConfig();
			syncAdminUiBinding(config);
			if ((previousAdminEnabled && !config.adminEnabled) || previousAdminEndpoint !== adminUiOptions.endpoint || previousAdminGeneration !== adminUiOptions.credentialGeneration) {
				adminExecutor.disable();
			}
		} catch {
			manager.reset();
			latestProjection = undefined;
			adminExecutor.disable();
			replaceProvider(providerConfig(oauth));
			if (manual) notify(ctx, "omniroute: configuration unavailable", "warning");
			return;
		}
		let environment: { endpoint: string; credential: string; generation: number } | undefined;
		try {
			environment = envBinding(config.allowInsecureHttp);
		} catch {
			// An incomplete/conflicting environment binding is never allowed to
			// fall back to a profile endpoint or send a credential.
			latestProjection = undefined;
			manager.reset();
			replaceProvider(providerConfig(oauth));
			if (manual) notify(ctx, "omniroute: invalid environment binding", "warning");
			return;
		}
		const credential = environment?.credential ?? await resolveRuntimeCredential(ctx.modelRegistry);
		if (!environment && config.pending) {
			const candidateKey = pendingCandidateKey;
			if (candidateKey === undefined || credential === undefined || credential !== candidateKey || pendingCandidateEndpoint !== config.pending.endpoint) {
				manager.reset();
				latestProjection = undefined;
				replaceProvider(providerConfig(oauth));
				if (manual) notify(ctx, "cruxomni: setup recovery required; sign in again, then /cruxomni refresh", "warning");
				return;
			}
			manager.setBinding(config.pending.endpoint, candidateKey, config.pending.generation);
			try {
				const validation = await manager.refresh();
				if (!validation || validation.stale) throw new Error("pending validation did not return a live catalog");
				await recoverPendingAfterPersistence(ctx.modelRegistry, candidateKey);
				config = await loadConfig();
				pendingCandidateKey = undefined;
				pendingCandidateEndpoint = undefined;
				if (config.pending || config.active?.endpoint !== manager.currentBinding?.endpoint) throw new Error("pending binding changed during validation");
				applyProjection(validation.projection);
				if (manual) notify(ctx, `omniroute: refreshed ${validation.projection.models.length} live models`);
				return;
			} catch {
				manager.reset();
				latestProjection = undefined;
				replaceProvider(providerConfig(oauth));
			}
			if (manual) notify(ctx, "cruxomni: setup validation failed; sign in again, then /cruxomni refresh", "warning");
			return;
		}
		const active = environment ?? config.active;
		const previous = manager.currentBinding;
		const bindingChanged = previous?.endpoint !== active?.endpoint || previous?.credential !== credential || previous?.generation !== active?.generation;
		manager.setBinding(active?.endpoint, credential, active?.generation);
		if (bindingChanged) {
			latestProjection = undefined;
			replaceProvider(runtimeProviderConfig(active?.endpoint));
		}
		if (!active || !credential) {
			if (manual) notify(ctx, "cruxomni: setup required; use native sign-in, then /cruxomni refresh", "info");
			return;
		}
		try {
			const result = await manager.refresh();
			if (result) applyProjection(result.projection);
			if (manual && result) notify(ctx, `omniroute: refreshed ${result.projection.models.length} live models${result.stale ? " (stale same-generation rows)" : ""}`, result.stale ? "warning" : "info");
		} catch (error) {
			if (manual) notify(ctx, `omniroute: refresh failed; no new catalog accepted (${safeDetail(error)})`, "warning");
		}
		syncAdminUiBinding(config);
	}

	const setup = createSetupWizard({
		credentials: optionalCredentials,
		refresh: ctx => refresh(ctx, true),
		status: () => `${manager.status.state}; models=${manager.status.modelCount}; metadata=${metadataState}`,
		synchronizeAdmin: async ctx => {
			context = ctx;
			const current = await loadConfig();
			const active = resolveEnvironmentBinding(current) ?? current.active;
			adminExecutor.disable();
			if (current.adminEnabled && active) adminExecutor.setAdminBinding({ profileId: "omniroute", endpoint: active.endpoint, credentialGeneration: active.generation }, true);
			await synchronizeAdministration();
		},
	});
	pi.registerCommand("cruxomni", {
		description: "Refresh or inspect OmniRoute provider state",
		handler: async (args, ctx) => {
			const commandParts = args.trim().split(/\s+/);
			const command = commandParts[0] ?? "status";
			const typed = ctx;
			if (command === "setup") await setup(typed);
			else if (command === "refresh") await refresh(typed, true);
			else if (command === "pricing") {
				const file = config.pricingFile ?? process.env[PRICING_ENV]?.trim();
				await loadPricing(file);
				const modelId = commandParts[1];
				const inspection = modelId ? latestProjection?.pricing.get(modelId) : undefined;
				if (modelId && !inspection) notify(ctx, "omniroute: model_not_in_live_catalog", "warning");
				else if (inspection) notify(ctx, `omniroute pricing ${modelId}: ${inspection.state}; fields=${JSON.stringify(inspection.fields)}; cost=${JSON.stringify(inspection.cost)}; reasons=${inspection.reasons.join(",")}; ${PRICING_WARNING}`);
				else notify(ctx, `omniroute pricing: ${pricingCurrent ? "current file" : "unavailable"}; ${PRICING_WARNING}`);
			} else {
				const status: HealthSnapshot = manager.status;
				notify(ctx, `omniroute: ${status.state}; models=${status.modelCount}${status.stale ? "; stale same-generation rows" : ""}${status.lastError ? `; detail=${status.lastError}` : ""}`);
			}
		},
	});
	pi.registerCommand("cruxomni-pricing", {
		description: "Inspect source-backed OmniRoute pricing",
		handler: async (args, ctx) => {
			const file = config.pricingFile ?? process.env[PRICING_ENV]?.trim();
			await loadPricing(file);
			const modelId = args.trim();
			const inspection = modelId ? latestProjection?.pricing.get(modelId) : undefined;
			if (modelId && !inspection) notify(ctx, "omniroute: model_not_in_live_catalog", "warning");
			else if (inspection) notify(ctx, `omniroute pricing ${modelId}: ${inspection.state}; fields=${JSON.stringify(inspection.fields)}; cost=${JSON.stringify(inspection.cost)}; reasons=${inspection.reasons.join(",")}; ${PRICING_WARNING}`);
			else notify(ctx, `omniroute pricing: ${pricingCurrent ? "current file" : "unavailable"}; ${PRICING_WARNING}`);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		stopped = false;
		transitionNotifications = false;
		manager.resume();
		await refresh(context, false);
		const settings = typeof ctx.cwd === "string" ? await getPluginSettings(PACKAGE_NAME, ctx.cwd).catch(() => ({} as Record<string, unknown>)) : {};
		transitionNotifications = settings.notifyTransitions !== false;
		if (ctx.mode === "tui" && settings.showSetupInvitation !== false && !config.invitationDismissed && !config.active && !config.pending && !envBinding(config.allowInsecureHttp)) {
			notify(ctx, `${DISPLAY_NAME}: connect your gateway with /cruxomni setup. You can open setup at any time.`);
			try { config = await updateConfig(current => ({ ...current, invitationDismissed: true })); } catch { /* A conflict never forces setup or overwrites another writer. */ }
		}
	});
	pi.on("session_shutdown", () => {
		latestProjection = undefined;
		pendingCandidateKey = undefined;
		pendingCandidateEndpoint = undefined;
		stopped = true;
		transitionNotifications = false;
		context = undefined;
		manager.shutdown();
		adminExecutor.shutdown();
		optionalCredentials.clear();
	});
}

export { registerOmniRouteProvider };
