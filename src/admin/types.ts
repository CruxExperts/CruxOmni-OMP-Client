import type { OperationDescriptor, OperationRegistry, ValidatedOperationInput } from "./registry.ts";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type AdminMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";
export type AdminAuthDomain = "public" | "runtime" | "management" | "local";
export type AdminSideEffect = "read" | "unknown" | "mutation" | "secret" | "lifecycle" | "destructive";
export type AdminRisk = "read" | "gated-read" | "mutation" | "secret" | "lifecycle" | "destructive";

/** A session-only management credential. Secret values are intentionally not serializable. */
export interface AdminCredentialBinding {
  readonly profileId: string;
  readonly endpoint: string;
  readonly credentialGeneration: number;
  readonly scopes: readonly string[];
  readonly enabled: boolean;
}

export interface AdminCredentialInput {
  readonly profileId: string;
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly cookie?: string;
  readonly scopes?: readonly string[];
  readonly credentialGeneration?: number;
}

export interface AdminTarget {
  readonly profileId: string;
  readonly endpoint: string;
  readonly credentialGeneration: number;
  readonly digest: string;
}

export interface AdminPlanHandle {
  readonly planId: string;
  readonly operationId: string;
  readonly profileId: string;
  readonly endpoint: string;
  readonly credentialGeneration: number;
  readonly payloadDigest: string;
  readonly targetDigest: string;
  readonly risk: AdminRisk;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: "pending" | "applying" | "applied" | "operator-required" | "unknown" | "expired" | "invalidated";
  readonly preview: AdminPreview;
}

export interface AdminPreview {
  readonly operationId: string;
  readonly method: AdminMethod;
  readonly pathTemplate: string;
  readonly target: { readonly profileId: string; readonly endpoint: string };
  readonly risk: AdminRisk;
  readonly confirmationRequired: boolean;
  readonly sideEffect: AdminSideEffect;
  readonly payload: ValidatedOperationInput;
  readonly projectedTarget?: unknown;
  readonly consequence: string;
  readonly resolvedPath: string;
  readonly query: Readonly<Record<string, AdminQueryValue>>;
  readonly planDigest: string;
}
export type AdminQueryValue = string | number | boolean | undefined;

export interface AdminRequest {
  readonly operationId: string;
  readonly method: AdminMethod;
  readonly url: string;
  readonly path: string;
  readonly query: Readonly<Record<string, AdminQueryValue>>;
  readonly body?: JsonValue;
  readonly operation: OperationDescriptor;
}

export interface AdminDispatchContext {
  readonly profileId: string;
  readonly endpoint: string;
  readonly credentialGeneration: number;
  readonly credential: AdminCredentialInput;
  readonly retryAllowed: boolean;
  readonly maxAttempts: number;
  readonly signal?: AbortSignal;
}

export interface AdminReconcileContext extends AdminDispatchContext {
  readonly operation: OperationDescriptor;
  readonly request: AdminRequest;
  readonly originalError: unknown;
}

export type AdminDispatch = (request: AdminRequest, context: AdminDispatchContext) => Promise<unknown>;
export type AdminTargetReader = (context: {
  readonly profileId: string;
  readonly endpoint: string;
  readonly credentialGeneration: number;
  readonly credential: AdminCredentialInput;
  readonly operation: OperationDescriptor;
  readonly payload: ValidatedOperationInput;
  readonly signal?: AbortSignal;
}) => Promise<string | AdminTarget | { readonly digest: string }>;
export type AdminReconciler = (context: AdminReconcileContext) => Promise<unknown>;

export interface AdminExecutorOptions {
  readonly dispatch: AdminDispatch;
  readonly readTarget?: AdminTargetReader;
  readonly reconcile?: AdminReconciler;
  readonly registry?: OperationRegistry;
  readonly planTtlMs?: number;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

export interface AdminApplyAuthorization {
  /** Human confirmation; aliases are accepted for adapters that use confirm. */
  readonly confirmed?: boolean;
  readonly confirm?: boolean;
  /** A headless caller is never allowed to apply, even when yolo is set. */
  readonly headless?: boolean;
  readonly profileId?: string;
  readonly endpoint?: string;
  readonly credentialGeneration?: number;
  readonly targetDigest?: string;
  readonly signal?: AbortSignal;
}

export type AdminErrorCode =
  | "unknown-operation"
  | "non-invokable"
  | "operation-unavailable"
  | "invalid-input"
  | "credential-required"
  | "credential-disabled"
  | "credential-mismatch"
  | "missing-scope"
  | "invalid-endpoint"
  | "plan-not-found"
  | "plan-expired"
  | "plan-invalidated"
  | "plan-already-applied"
  | "plan-in-progress"
  | "confirmation-required"
  | "headless-denied"
  | "target-drift"
  | "preview-too-large"
  | "dispatch-failed"
  | "unauthorized"
  | "uncertain-outcome"
  | "reconciliation-failed"
  | "shutdown";

export interface AdminErrorDetails {
  readonly status?: number;
  readonly operationId?: string;
  readonly correlationId: string;
}

export class AdminError extends Error {
  readonly code: AdminErrorCode;
  readonly status: number | undefined;
  readonly operationId: string | undefined;
  readonly correlationId: string;

  constructor(code: AdminErrorCode, message: string, details: AdminErrorDetails) {
    super(escapeControls(message));
    this.name = "AdminError";
    this.code = code;
    this.status = details.status;
    this.operationId = details.operationId;
    this.correlationId = sanitizeCorrelation(details.correlationId);
  }

  toJSON(): AdminErrorResult {
    return {
      code: this.code,
      correlationId: this.correlationId,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.operationId === undefined ? {} : { operationId: this.operationId }),
    };
  }
}

export interface AdminErrorResult {
  readonly code: AdminErrorCode;
  readonly status?: number;
  readonly operationId?: string;
  readonly correlationId: string;
}

export interface AdminApplyResult {
  readonly status: "applied" | "denied" | "operator-required" | "unknown";
  readonly plan: AdminPlanHandle;
  readonly output?: unknown;
  readonly error?: AdminErrorResult;
}

export interface AdminReadResult {
  readonly operationId: string;
  readonly output: unknown;
  readonly correlationId: string;
}

export function escapeControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function sanitizeCorrelation(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return cleaned || "redacted";
}

export function safeError(error: unknown): { status?: number; uncertain: boolean } {
  if (error instanceof AdminError) {
    return { ...(error.status === undefined ? {} : { status: error.status }), uncertain: error.code === "uncertain-outcome" };
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const status = typeof record.status === "number" && Number.isFinite(record.status) ? record.status : undefined;
    const code = typeof record.code === "string" ? record.code : "";
    const networkFailure = status === undefined && ["aborted", "network", "request_failed", "timeout"].includes(code);
    return { ...(status === undefined ? {} : { status }), uncertain: record.uncertain === true || code === "network-lost-response" || networkFailure };
  }
  return { uncertain: false };
}
