import { createHash, randomBytes } from "node:crypto";
import type {
  AdminApplyAuthorization,
  AdminApplyResult,
  AdminCredentialBinding,
  AdminCredentialInput,
  AdminDispatch,
  AdminDispatchContext,
  AdminErrorCode,
  AdminExecutorOptions,
  AdminPlanHandle,
  AdminPreview,
  AdminReadResult,
  AdminReconcileContext,
  AdminRequest,
  AdminRisk,
  AdminTarget,
  AdminTargetReader,
  JsonObject,
  JsonValue,
} from "./types.ts";
import { AdminError, escapeControls, safeError } from "./types.ts";
import {
  canonicalizeJson,
  operationRegistry,
  type OperationAdapter,
  type OperationDescriptor,
  type OperationRegistry,
  type ValidatedOperationInput,
} from "./registry.ts";

export interface AdminPlanOptions {
  readonly profileId?: string;
  readonly endpoint?: string;
  readonly targetDigest?: string;
  readonly confirmed?: boolean;
  readonly confirm?: boolean;
  readonly headless?: boolean;
  readonly signal?: AbortSignal;
}

export interface AdminExecutor {
  setAdminBinding(input: { profileId: string; endpoint: string; credentialGeneration: number }, explicitHuman?: boolean): void;
  clearAdminBinding(): void;
  bindCredential(input: AdminCredentialInput): AdminCredentialBinding;
  getCredentialBinding(): AdminCredentialBinding | undefined;
  logout(): void;
  disable(): void;
  shutdown(): void;
  clearSession(): void;
  clear(): void;
  getPlan(planId: string): AdminPlanHandle | undefined;
  read(operationId: string, input: unknown, options?: AdminPlanOptions): Promise<AdminReadResult>;
  plan(operationId: string, input: unknown, options?: AdminPlanOptions): Promise<AdminPlanHandle>;
  preview(operationId: string, input: unknown, options?: AdminPlanOptions): Promise<AdminPlanHandle>;
  apply(planId: string, authorization: AdminApplyAuthorization): Promise<AdminApplyResult>;
  invalidatePlans(): void;
}

interface InternalCredential extends AdminCredentialInput {
  readonly scopes: readonly string[];
  readonly credentialGeneration: number;
  readonly enabled: boolean;
}

interface InternalPlan {
  readonly planId: string;
  readonly operation: OperationAdapter;
  readonly input: ValidatedOperationInput;
  readonly payloadDigest: string;
  readonly targetDigest: string;
  readonly profileId: string;
  readonly endpoint: string;
  readonly credentialGeneration: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly preview: AdminPreview;
  state: AdminPlanHandle["state"];
}

const DEFAULT_PLAN_TTL_MS = 60_000;
const MAX_PLAN_TTL_MS = 300_000;
const SAFE_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MAX_PREVIEW_BYTES = 7_000;
const MAX_PREVIEW_DEPTH = 32;

function throwIfAborted(signal: AbortSignal | undefined, operationId?: string): void {
  if (signal?.aborted) throw new AdminError("plan-invalidated", "operation was cancelled", { correlationId: correlationId(), ...(operationId === undefined ? {} : { operationId }) });
}

function previewDepth(value: unknown, depth = 0): number {
  if (depth > MAX_PREVIEW_DEPTH) return depth;
  if (!value || typeof value !== "object") return depth;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return children.reduce((maximum, child) => Math.max(maximum, previewDepth(child, depth + 1)), depth);
}

function privateEndpoint(endpoint: string): string {
  if (!endpoint || /[\u0000-\u001f\u007f]/.test(endpoint)) throw new AdminError("invalid-endpoint", "endpoint is invalid", { correlationId: correlationId() });
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new AdminError("invalid-endpoint", "endpoint is invalid", { correlationId: correlationId() }); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new AdminError("invalid-endpoint", "endpoint is invalid", { correlationId: correlationId() });
  return parsed.toString().replace(/\/$/, "");
}

function correlationId(): string {
  return `c-${randomBytes(8).toString("hex")}`;
}

function planId(): string {
  return `p-${randomBytes(16).toString("hex")}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value)).digest("hex");
}

function nowDefault(): number {
  return Date.now();
}
function boundedPlanTtl(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PLAN_TTL_MS;
  return Math.min(MAX_PLAN_TTL_MS, Math.max(1_000, Math.floor(value)));
}

function errorResult(error: AdminError): { code: AdminErrorCode; status?: number; operationId?: string; correlationId: string } {
  return error.toJSON();
}

function isSensitive(key: string, descriptor: OperationDescriptor): boolean {
  return descriptor.secrets.inputFields.some((field) => field.toLowerCase() === key.toLowerCase()) || /(?:secret|password|token|credential|authorization|cookie|api[-_]?key)/i.test(key);
}

function redactInput(value: unknown, descriptor: OperationDescriptor, key?: string): unknown {
  if (key && isSensitive(key, descriptor)) return "[redacted]";
  if (key === "body" && (descriptor.sideEffect === "secret" || descriptor.secrets.inputFields.length > 0) && (typeof value !== "object" || value === null)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactInput(item, descriptor));
  if (value && typeof value === "object") {
    const output: JsonObject = {};
    for (const [field, child] of Object.entries(value as Record<string, unknown>)) {
      const redacted = redactInput(child, descriptor, field);
      if (redacted !== undefined) output[field] = redacted as JsonValue;
    }
    return output;
  }
  return typeof value === "string" ? escapeControls(value) : value;
}

function safeBinding(binding: InternalCredential): AdminCredentialBinding {
  return {
    profileId: binding.profileId,
    endpoint: binding.endpoint,
    credentialGeneration: binding.credentialGeneration,
    scopes: [...(binding.scopes ?? [])],
    enabled: binding.enabled,
  };
}

function queryValue(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return canonicalizeJson(value);
}

function requestFor(adapter: OperationAdapter, endpoint: string, input: ValidatedOperationInput): AdminRequest {
  const path = adapter.buildPath(input);
  const sourceQuery = input.query;
  const query: Record<string, string | number | boolean | undefined> = {};
  const queryString = Object.keys(sourceQuery).sort().flatMap((key) => {
    const value = sourceQuery[key];
    if (Array.isArray(value)) {
      const encoded = value.map((item) => queryValue(item));
      query[key] = encoded.join(",");
      return encoded.map((item) => `${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
    }
    const encoded = queryValue(value);
    query[key] = encoded;
    return `${encodeURIComponent(key)}=${encodeURIComponent(encoded)}`;
  }).join("&");
  const url = `${endpoint}${path}${queryString ? `?${queryString}` : ""}`;
  return {
    operationId: adapter.descriptor.operationId,
    method: adapter.descriptor.method,
    url,
    path,
    query,
    operation: adapter.descriptor,
    ...(input.body === undefined ? {} : { body: input.body }),
  };
}

function targetDigestFrom(value: string | AdminTarget | { readonly digest: string }): string {
  if (typeof value === "string") return value;
  return value.digest;
}

function consequence(descriptor: OperationDescriptor, risk: AdminRisk): string {
  if (risk === "read") return "Read-only operation; response is projected through the closed allowlist.";
  if (risk === "gated-read") return "Nominal read is gated because the pinned source declares possible side effects.";
  return descriptor.confirmation.reason;
}

export class AdminExecutorImpl implements AdminExecutor {
  readonly #dispatch: AdminDispatch;
  readonly #readTarget: AdminTargetReader | undefined;
  readonly #reconcile: ((context: AdminReconcileContext) => Promise<unknown>) | undefined;
  readonly #registry: OperationRegistry;
  readonly #planTtlMs: number;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #plans = new Map<string, InternalPlan>();
  #credential: InternalCredential | undefined;
  #adminBinding: { profileId: string; endpoint: string; credentialGeneration: number; enabled: boolean } | undefined;
  #generation = 0;
  #stopped = false;
  #credentialBindingBlocked = false;

  constructor(options: AdminExecutorOptions) {
    this.#dispatch = options.dispatch;
    this.#readTarget = options.readTarget;
    this.#reconcile = options.reconcile;
    this.#registry = options.registry ?? operationRegistry;
    this.#planTtlMs = boundedPlanTtl(options.planTtlMs);
    this.#now = options.now ?? nowDefault;
    this.#randomId = options.randomId ?? planId;
  }

  setAdminBinding(input: { profileId: string; endpoint: string; credentialGeneration: number }, explicitHuman = false): void {
    if (this.#stopped) throw this.#error("shutdown", "administration is shut down");
    const next = { profileId: input.profileId, endpoint: privateEndpoint(input.endpoint), credentialGeneration: input.credentialGeneration, enabled: true };
    const current = this.#adminBinding;
    if (explicitHuman) this.#credentialBindingBlocked = false;
    if (current?.enabled && current.profileId === next.profileId && current.endpoint === next.endpoint && current.credentialGeneration === next.credentialGeneration) return;
    this.invalidatePlans();
    this.#adminBinding = next;
  }

  clearAdminBinding(): void {
    this.invalidatePlans();
    this.#adminBinding = undefined;
  }

  bindCredential(input: AdminCredentialInput): AdminCredentialBinding {
    if (this.#stopped) throw this.#error("shutdown", "administration is shut down");
    if (this.#credentialBindingBlocked) throw this.#error("credential-disabled", "credential rebinding requires an explicit human enable action");
    if (/[\u0000-\u001f\u007f]/.test(input.apiKey ?? "") || /[\u0000-\u001f\u007f]/.test(input.cookie ?? "")) throw this.#error("credential-required", "credential binding is invalid");
    const endpoint = privateEndpoint(input.endpoint);
    if (!input.profileId || /[\u0000-\u001f\u007f]/.test(input.profileId)) throw this.#error("credential-mismatch", "credential binding is invalid");
    if ((input.apiKey === undefined) === (input.cookie === undefined) || (input.apiKey !== undefined && input.apiKey.length === 0) || (input.cookie !== undefined && input.cookie.length === 0)) throw this.#error("credential-required", "one management credential is required");
    const scopes = [...(input.scopes ?? [])];
    const current = this.#credential;
    if (current?.enabled && current.profileId === input.profileId && current.endpoint === endpoint
      && current.apiKey === input.apiKey && current.cookie === input.cookie
      && current.scopes.length === scopes.length && current.scopes.every((scope, index) => scope === scopes[index])) {
      this.setAdminBinding({ profileId: current.profileId, endpoint: current.endpoint, credentialGeneration: current.credentialGeneration });
      return safeBinding(current);
    }
    const requestedGeneration = input.credentialGeneration;
    const nextGeneration = requestedGeneration !== undefined && Number.isFinite(requestedGeneration) && requestedGeneration > 0
      ? Math.max(this.#generation + 1, Math.floor(requestedGeneration))
      : this.#generation + 1;
    this.#generation = nextGeneration;
    this.invalidatePlans();
    this.#credential = {
      profileId: input.profileId,
      endpoint,
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
      scopes,
      credentialGeneration: this.#generation,
      enabled: true,
    };
    this.setAdminBinding({ profileId: input.profileId, endpoint, credentialGeneration: this.#generation });
    return safeBinding(this.#credential);
  }

  getCredentialBinding(): AdminCredentialBinding | undefined {
    return this.#credential ? safeBinding(this.#credential) : undefined;
  }

  logout(): void {
    this.#generation += 1;
    this.invalidatePlans();
    this.#credential = undefined;
    this.#adminBinding = undefined;
    this.#credentialBindingBlocked = true;
  }
  clearSession(): void {
    this.logout();
  }

  clear(): void {
    this.logout();
  }

  disable(): void {
    this.#generation += 1;
    this.invalidatePlans();
    if (this.#credential) {
      this.#credential = {
        profileId: this.#credential.profileId,
        endpoint: this.#credential.endpoint,
        scopes: [],
        credentialGeneration: this.#generation,
        enabled: false,
      };
    }
    if (this.#adminBinding) this.#adminBinding = { ...this.#adminBinding, enabled: false, credentialGeneration: this.#generation };
    this.#credentialBindingBlocked = true;
  }

  shutdown(): void {
    this.#stopped = true;
    this.#generation += 1;
    this.invalidatePlans();
    this.#credential = undefined;
    this.#adminBinding = undefined;
  }

  invalidatePlans(): void {
    for (const plan of this.#plans.values()) {
      if (plan.state === "pending" || plan.state === "applying") plan.state = "invalidated";
    }
  }
  getPlan(planIdValue: string): AdminPlanHandle | undefined {
    const plan = this.#plans.get(planIdValue);
    if (!plan) return undefined;
    if (plan.state === "pending" && this.#now() >= plan.expiresAt) plan.state = "expired";
    return this.#handle(plan);
  }

  async read(operationId: string, input: unknown, options: AdminPlanOptions = {}): Promise<AdminReadResult> {
    throwIfAborted(options.signal, operationId);
    const adapter = this.#requireAdapter(operationId);
    const descriptor = adapter.descriptor;
    if (adapter.risk !== "read" || descriptor.confirmation.required || descriptor.sideEffect !== "read" || !SAFE_READ_METHODS.has(descriptor.method)) {
      throw this.#error("confirmation-required", "operation requires a human-confirmed plan", operationId);
    }
    const validated = this.#validate(adapter, input);
    const context = this.#context(options, descriptor);
    this.#assertEligible(adapter);
    const request = requestFor(adapter, context.endpoint, validated);
    this.#assertEligible(adapter);
    const output = await this.#dispatch(request, this.#dispatchContext(context, descriptor, descriptor.retry.allowed && adapter.risk === "read" && SAFE_READ_METHODS.has(descriptor.method), options.signal));
    return { operationId, output: adapter.project(output), correlationId: correlationId() };
  }

  async plan(operationId: string, input: unknown, options: AdminPlanOptions = {}): Promise<AdminPlanHandle> {
    throwIfAborted(options.signal, operationId);
    if (this.#stopped) throw this.#error("shutdown", "administration is shut down", operationId);
    const adapter = this.#requireAdapter(operationId);
    const validated = this.#validate(adapter, input);
    const context = this.#context(options, adapter.descriptor);
    this.#assertEligible(adapter);
    const target = await this.#targetDigest(context, adapter.descriptor, validated, options.targetDigest, options.signal);
    throwIfAborted(options.signal, operationId);
    const createdAt = this.#now();
    const payloadDigest = digest(validated);
    const previewPayload = redactInput(validated, adapter.descriptor) as ValidatedOperationInput;
    const request = requestFor(adapter, context.endpoint, validated);
    const previewBase = {
      operationId,
      method: adapter.descriptor.method,
      pathTemplate: adapter.descriptor.pathTemplate,
      target: { profileId: context.profileId, endpoint: context.endpoint },
      risk: adapter.risk,
      confirmationRequired: adapter.risk !== "read" || adapter.descriptor.confirmation.required,
      sideEffect: adapter.descriptor.sideEffect,
      payload: previewPayload,
      ...(target === "unavailable" ? {} : { projectedTarget: target }),
      consequence: consequence(adapter.descriptor, adapter.risk),
      resolvedPath: request.path,
      query: request.query,
    };
    if (previewDepth(previewBase) > MAX_PREVIEW_DEPTH || new TextEncoder().encode(canonicalizeJson(previewBase)).byteLength > MAX_PREVIEW_BYTES) {
      throw this.#error("preview-too-large", "complete redacted preview exceeds the approval limit", operationId);
    }
    const preview: AdminPreview = { ...previewBase, planDigest: digest(previewBase) };
    const internal: InternalPlan = {
      planId: this.#randomId(),
      operation: adapter,
      input: validated,
      payloadDigest,
      targetDigest: target,
      profileId: context.profileId,
      endpoint: context.endpoint,
      credentialGeneration: context.credentialGeneration,
      createdAt,
      expiresAt: createdAt + this.#planTtlMs,
      preview,
      state: "pending",
    };
    this.#plans.set(internal.planId, internal);
    return this.#handle(internal);
  }

  async preview(operationId: string, input: unknown, options: AdminPlanOptions = {}): Promise<AdminPlanHandle> {
    return this.plan(operationId, input, options);
  }

  async apply(planIdValue: string, authorization: AdminApplyAuthorization): Promise<AdminApplyResult> {
    const plan = this.#plans.get(planIdValue);
    if (!plan) throw this.#error("plan-not-found", "plan is not available");
    const currentTime = this.#now();
    if (currentTime >= plan.expiresAt && plan.state === "pending") plan.state = "expired";
    if (plan.state === "expired") throw this.#error("plan-expired", "plan has expired", plan.operation.descriptor.operationId);
    if (plan.state === "invalidated") throw this.#error("plan-invalidated", "plan is no longer valid", plan.operation.descriptor.operationId);
    if (plan.state === "applying") throw this.#error("plan-in-progress", "plan application is already in progress", plan.operation.descriptor.operationId);
    if (plan.state === "applied" || plan.state === "operator-required" || plan.state === "unknown") throw this.#error("plan-already-applied", "plan reached a terminal state", plan.operation.descriptor.operationId);
    const confirmed = authorization.confirmed === true || authorization.confirm === true;
    if (authorization.headless === true) return this.#denied(plan, "headless-denied", "headless execution is denied");
    if (!confirmed) return this.#denied(plan, "confirmation-required", "human confirmation is required");
    if (plan.operation.risk !== "read" && !this.#readTarget) throw this.#error("target-drift", "mutable target cannot be re-read", plan.operation.descriptor.operationId);
    if (this.#stopped) throw this.#error("shutdown", "administration is shut down", plan.operation.descriptor.operationId);
    this.#assertEligible(plan.operation);
    const credential = this.#credential;
    if (!credential) throw this.#error("credential-required", "management credential is required", plan.operation.descriptor.operationId);
    if (!credential.enabled || !this.#adminBinding?.enabled) throw this.#error("credential-disabled", "management credential is disabled", plan.operation.descriptor.operationId);
    if (credential.profileId !== plan.profileId || credential.endpoint !== plan.endpoint || credential.credentialGeneration !== plan.credentialGeneration) throw this.#error("credential-mismatch", "credential binding changed", plan.operation.descriptor.operationId);
    for (const scope of plan.operation.descriptor.auth.scopes) if (!credential.scopes.includes(scope)) throw this.#error("missing-scope", "credential lacks required scope", plan.operation.descriptor.operationId);
    if (authorization.profileId !== undefined && authorization.profileId !== plan.profileId) throw this.#error("credential-mismatch", "profile changed", plan.operation.descriptor.operationId);
    if (authorization.endpoint !== undefined && privateEndpoint(authorization.endpoint) !== plan.endpoint) throw this.#error("credential-mismatch", "endpoint changed", plan.operation.descriptor.operationId);
    if (authorization.credentialGeneration !== undefined && authorization.credentialGeneration !== plan.credentialGeneration) throw this.#error("credential-mismatch", "credential generation changed", plan.operation.descriptor.operationId);
    if (authorization.targetDigest !== undefined && authorization.targetDigest !== plan.targetDigest) throw this.#error("target-drift", "target changed since preview", plan.operation.descriptor.operationId);
    throwIfAborted(authorization.signal, plan.operation.descriptor.operationId);
    plan.state = "applying";
    const currentTarget = await this.#targetDigest({ profileId: plan.profileId, endpoint: plan.endpoint, credentialGeneration: plan.credentialGeneration }, plan.operation.descriptor, plan.input, undefined, authorization.signal);
    const currentCredential = this.#credential;
    if (this.#stopped || this.#now() >= plan.expiresAt || authorization.signal?.aborted
      || !this.#adminBinding?.enabled || !currentCredential?.enabled
      || currentCredential.profileId !== plan.profileId || currentCredential.endpoint !== plan.endpoint
      || currentCredential.credentialGeneration !== plan.credentialGeneration) {
      plan.state = "invalidated";
      throw this.#error("plan-invalidated", "plan binding changed during final verification", plan.operation.descriptor.operationId);
    }
    if (plan.operation.risk !== "read" && (plan.targetDigest === "unavailable" || currentTarget === "unavailable")) {
      plan.state = "invalidated";
      throw this.#error("target-drift", "mutable target could not be re-read", plan.operation.descriptor.operationId);
    }
    if (plan.targetDigest !== "unavailable" && currentTarget !== plan.targetDigest) {
      plan.state = "invalidated";
      throw this.#error("target-drift", "target changed since preview", plan.operation.descriptor.operationId);
    }
    const request = requestFor(plan.operation, plan.endpoint, plan.input);
    this.#assertEligible(plan.operation);
    // Mark before dispatch: a lost response must never be replayed as a second write.
    plan.state = "applied";
    try {
      const result = await this.#dispatch(request, this.#dispatchContext({ profileId: plan.profileId, endpoint: plan.endpoint, credentialGeneration: plan.credentialGeneration }, plan.operation.descriptor, plan.operation.descriptor.retry.allowed && plan.operation.risk === "read" && SAFE_READ_METHODS.has(plan.operation.descriptor.method), authorization.signal));
      if (result && typeof result === "object" && "status" in result && (result as { status?: unknown }).status === "operator-required") {
        plan.state = "operator-required";
        return { status: "operator-required", plan: this.#handle(plan), output: result };
      }
      return { status: "applied", plan: this.#handle(plan), output: plan.operation.project(result) };
    } catch (error) {
      const failure = safeError(error);
      if (failure.status === 401 || failure.status === 403) throw this.#error("unauthorized", "administration request was not authorized", plan.operation.descriptor.operationId, failure.status);
      if (failure.uncertain) {
        plan.state = "unknown";
        const reconciled = await this.#reconcileOutcome(plan, request, error, authorization.signal);
        if (reconciled !== undefined) return { status: "unknown", plan: this.#handle(plan), output: reconciled, error: errorResult(this.#error("uncertain-outcome", "mutation outcome is uncertain", plan.operation.descriptor.operationId)) };
        return { status: "unknown", plan: this.#handle(plan), error: errorResult(this.#error("uncertain-outcome", "mutation outcome is uncertain", plan.operation.descriptor.operationId)) };
      }
      throw this.#error("dispatch-failed", "administration request failed", plan.operation.descriptor.operationId, failure.status);
    }
  }

  #requireAdapter(operationId: string): OperationAdapter {
    try { return this.#registry.require(operationId); } catch (error) {
      if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") throw this.#error((error as { code: AdminErrorCode }).code, "operation is not invokable", operationId);
      throw error;
    }
  }

  #assertEligible(adapter: OperationAdapter): void {
    if (adapter.eligibility.status !== "verified") {
      throw this.#error("operation-unavailable", adapter.eligibility.reason, adapter.descriptor.operationId);
    }
  }

  #validate(adapter: OperationAdapter, input: unknown): ValidatedOperationInput {
    try { return adapter.validate(input); } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "invalid-input") throw this.#error("invalid-input", "operation input is invalid", adapter.descriptor.operationId);
      throw error;
    }
  }

  #context(options: AdminPlanOptions, descriptor: OperationDescriptor): { profileId: string; endpoint: string; credentialGeneration: number } {
    const credential = this.#credential;
    const binding = this.#adminBinding;
    if (!binding?.enabled) throw this.#error("credential-disabled", "administration is not enabled", descriptor.operationId);
    if (!credential?.enabled) throw this.#error("credential-required", "management credential is required", descriptor.operationId);
    const profileId = options.profileId ?? binding.profileId;
    const endpoint = privateEndpoint(options.endpoint ?? binding.endpoint);
    const credentialGeneration = credential && credential.profileId === profileId && credential.endpoint === endpoint ? credential.credentialGeneration : this.#generation;
    if (binding.profileId !== profileId || binding.endpoint !== endpoint || binding.credentialGeneration !== credentialGeneration
      || credential.profileId !== profileId || credential.endpoint !== endpoint) throw this.#error("credential-mismatch", "management binding changed", descriptor.operationId);
    if (descriptor.auth.domain === "local") {
      const host = new URL(endpoint).hostname;
      if (!LOOPBACK_HOSTS.has(host)) throw this.#error("invalid-endpoint", "local operation requires a loopback endpoint", descriptor.operationId);
    }
    for (const scope of descriptor.auth.scopes) if (!credential.scopes.includes(scope)) throw this.#error("missing-scope", "credential lacks required scope", descriptor.operationId);
    return { profileId, endpoint, credentialGeneration };
  }

  #dispatchContext(context: { profileId: string; endpoint: string; credentialGeneration: number }, descriptor: OperationDescriptor, retryAllowed: boolean, signal?: AbortSignal): AdminDispatchContext {
    const bound = this.#credential;
    const credential = bound && bound.profileId === context.profileId && bound.endpoint === context.endpoint && bound.credentialGeneration === context.credentialGeneration ? bound : undefined;
    if (!credential) {
      return {
        ...context,
        credential: { profileId: context.profileId, endpoint: context.endpoint },
        retryAllowed,
        maxAttempts: retryAllowed ? Math.min(2, descriptor.retry.maxAttempts) : 1,
        ...(signal === undefined ? {} : { signal }),
      };
    }
    return {
      ...context,
      credential,
      retryAllowed,
      maxAttempts: retryAllowed ? Math.min(2, descriptor.retry.maxAttempts) : 1,
      ...(signal === undefined ? {} : { signal }),
    };
  }

  async #targetDigest(context: { profileId: string; endpoint: string; credentialGeneration: number }, descriptor: OperationDescriptor, payload: ValidatedOperationInput, supplied: string | undefined, signal?: AbortSignal): Promise<string> {
    if (supplied !== undefined) return supplied;
    if (!this.#readTarget) return "unavailable";
    const bound = this.#credential;
    const credential: AdminCredentialInput = bound && bound.profileId === context.profileId && bound.endpoint === context.endpoint && bound.credentialGeneration === context.credentialGeneration
      ? bound
      : { profileId: context.profileId, endpoint: context.endpoint };
    const result = await this.#readTarget({ ...context, credential, operation: descriptor, payload, ...(signal === undefined ? {} : { signal }) });
    return targetDigestFrom(result);
  }

  async #reconcileOutcome(plan: InternalPlan, request: AdminRequest, originalError: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.#reconcile) return undefined;
    const context: AdminReconcileContext = {
      ...this.#dispatchContext({ profileId: plan.profileId, endpoint: plan.endpoint, credentialGeneration: plan.credentialGeneration }, plan.operation.descriptor, false, signal),
      operation: plan.operation.descriptor,
      request,
      originalError,
    };
    try {
      const result = await this.#reconcile(context);
      return plan.operation.project(result);
    } catch {
      return undefined;
    }
  }

  #handle(plan: InternalPlan): AdminPlanHandle {
    return {
      planId: plan.planId,
      operationId: plan.operation.descriptor.operationId,
      profileId: plan.profileId,
      endpoint: plan.endpoint,
      credentialGeneration: plan.credentialGeneration,
      payloadDigest: plan.payloadDigest,
      targetDigest: plan.targetDigest,
      risk: plan.operation.risk,
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      state: plan.state,
      preview: plan.preview,
    };
  }

  #denied(plan: InternalPlan, code: AdminErrorCode, message: string): AdminApplyResult {
    const error = this.#error(code, message, plan.operation.descriptor.operationId);
    return { status: "denied", plan: this.#handle(plan), error: errorResult(error) };
  }

  #error(code: AdminErrorCode, message: string, operationId?: string, status?: number): AdminError {
    return new AdminError(code, message, {
      correlationId: correlationId(),
      ...(operationId === undefined ? {} : { operationId }),
      ...(status === undefined ? {} : { status }),
    });
  }
}

export function createAdminExecutor(options: AdminExecutorOptions): AdminExecutor {
  return new AdminExecutorImpl(options);
}
