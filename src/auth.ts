import {
  ConfigError,
  commitPendingConfig,
  type PendingBinding,
  type PluginConfig,
  loadConfig,
  resolveEnvironmentBinding,
  savePendingConfig,
  validateEndpoint,
} from "./config.ts";
import { requestJson, TransportError } from "./transport.ts";

export const PROVIDER_ID = "omniroute";

export type AuthErrorCode =
  | "cancelled"
  | "invalid-input"
  | "unauthorized"
  | "validation-failed"
  | "network-failure"
  | "persistence-failed"
  | "environment-bound";

export class AuthError extends Error {
  readonly name = "AuthError";
  constructor(readonly code: AuthErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface OAuthPromptOptions {
  message: string;
  secret?: boolean;
  placeholder?: string;
  initialValue?: string;
}

export interface OAuthLoginCallbacks {
  onPrompt(options: OAuthPromptOptions): Promise<string | undefined | null> | string | undefined | null;
  onConfirm?(options: { message: string; detail?: string }): Promise<boolean> | boolean;
  onMessage?(message: string, kind?: "info" | "warning" | "error"): Promise<void> | void;
}

export interface NativeLoginOptions {
  providerName?: string;
  onSetupComplete?: (endpoint: string, credential: string) => Promise<void> | void;
  load?: () => Promise<PluginConfig>;
  request?: typeof requestJson;
}

export interface NativeLoginProvider {
  name: string;
  login(callbacks: OAuthLoginCallbacks): Promise<string>;
}

export interface ModelRegistryCredentialReader {
  getApiKeyForProvider(name: string): Promise<string | undefined> | string | undefined;
}

interface PendingCandidate {
  endpoint: string;
  generation: number;
  key: string;
}

let pendingCandidate: PendingCandidate | undefined;

/** Forget the in-memory candidate so it cannot be reused after cancellation or shutdown. */
export function clearPendingCandidate(): void {
  pendingCandidate = undefined;
}


function promptValue(value: string | undefined | null, label: string): string {
  if (value === undefined || value === null) throw new AuthError("cancelled", `${label} prompt cancelled`);
  const trimmed = value.trim();
  if (!trimmed) throw new AuthError("invalid-input", `${label} is required`);
  return trimmed;
}

function isRemoteHttp(endpoint: string): boolean {
  const url = new URL(endpoint);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const octets = host.split(".");
  const loopbackV4 = octets.length === 4 && octets.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) && Number(octets[0]) === 127;
  const local = host === "localhost" || host === "localhost.localdomain" || host === "::1" || loopbackV4;
  return url.protocol === "http:" && !local;
}

async function confirmInsecure(callbacks: OAuthLoginCallbacks, endpoint: string): Promise<boolean> {
  if (!callbacks.onConfirm) return false;
  const result = await callbacks.onConfirm({
    message: "Allow insecure remote HTTP for this OmniRoute endpoint?",
    detail: `${endpoint} sends the API key without TLS. The choice is saved for this profile.`,
  });
  return result === true;
}


function hasStatus(error: unknown, status: number): boolean {
  return error instanceof TransportError && error.status === status;
}

async function validateCandidate(endpoint: string, key: string, request: typeof requestJson): Promise<"validated" | "network-failed"> {
  try {
    const result = await request(`${endpoint}/v1/models`, key, { totalBudgetMs: 10_000, maxBytes: 8 * 1024 * 1024, maxDepth: 24 }, undefined, { safeRead: true, maxRetries: 1 });
    if (result === null || typeof result !== "object" || Array.isArray(result) || !("data" in result) || !Array.isArray(result.data)
      || result.data.some(row => !row || typeof row !== "object" || typeof row.id !== "string" || !row.id.trim())) throw new AuthError("validation-failed", "OmniRoute /v1/models returned an invalid catalog");
    return "validated";
  } catch (error) {
    if (error instanceof TransportError && (error.code === "network" || error.code === "timeout" || error.code === "aborted")) return "network-failed";
    throw new AuthError("validation-failed", "OmniRoute candidate validation failed", { cause: error });
  }
}

/**
 * Create the native OMP login adapter. No credential is persisted here: OMP's
 * AuthStorage owns the returned API key. The profile only receives a pending
 * endpoint marker, allowing refresh to commit it after native persistence.
 */
export function registerNativeLogin(options: NativeLoginOptions = {}): NativeLoginProvider {
  const name = options.providerName ?? PROVIDER_ID;
  const request = options.request ?? requestJson;
  const load = options.load ?? loadConfig;
  return {
    name,
    async login(callbacks: OAuthLoginCallbacks): Promise<string> {
      // A new attempt invalidates any unresolved candidate from an earlier
      // attempt. The candidate is retained only until native AuthStorage has
      // persisted it and recovery either commits or fails closed.
      clearPendingCandidate();
      let config: PluginConfig;
      try {
        config = await load();
      } catch (error) {
        if (error instanceof ConfigError) throw new AuthError("persistence-failed", "unable to load OmniRoute profile configuration", { cause: error });
        throw error;
      }
      try {
        if (resolveEnvironmentBinding(config)) throw new AuthError("environment-bound", "environment credentials are read-only; remove overrides before using native login");
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw new AuthError("invalid-input", "invalid environment binding", { cause: error });
      }
      const existingEndpoint = config.active?.endpoint;
      const endpointPromptOptions: OAuthPromptOptions = {
        message: "OmniRoute base URL",
        placeholder: existingEndpoint ?? "https://omniroute.example",
      };
      if (existingEndpoint !== undefined) endpointPromptOptions.initialValue = existingEndpoint;
      const endpointPrompt = await callbacks.onPrompt(endpointPromptOptions);
      const enteredEndpoint = promptValue(endpointPrompt, "base URL");
      let endpoint: string;
      try {
        // Parse with insecure HTTP enabled first so a remote-HTTP candidate can
        // receive the explicit interactive warning rather than failing silently.
        endpoint = validateEndpoint(enteredEndpoint, true);
      } catch (error) {
        throw new AuthError("invalid-input", "invalid OmniRoute base URL", { cause: error });
      }
      let allowInsecureHttp = config.allowInsecureHttp;
      if (isRemoteHttp(endpoint) && !allowInsecureHttp) {
        if (!(await confirmInsecure(callbacks, endpoint))) throw new AuthError("cancelled", "insecure transport was not approved");
        allowInsecureHttp = true;
      }
      const keyPrompt = await callbacks.onPrompt({ message: "OmniRoute API key", secret: true });
      const key = promptValue(keyPrompt, "API key");
      const validation = await validateCandidate(endpoint, key, request);
      if (validation === "network-failed") {
        if (!(await callbacks.onConfirm?.({ message: "OmniRoute is unreachable. Save this endpoint as unverified?", detail: "No authenticated request will be retried until a manual refresh succeeds." }))) {
          throw new AuthError("network-failure", "candidate endpoint could not be reached");
        }
      }
      const pending: PendingBinding = {
        endpoint,
        generation: (config.active?.generation ?? 0) + 1,
        status: validation === "validated" ? "validated" : "unverified",
      };
      try {
        await savePendingConfig(
          { ...config, allowInsecureHttp, pending },
          { expectedRevision: config.revision ?? null },
        );
      } catch (error) {
        throw new AuthError("persistence-failed", "unable to stage OmniRoute endpoint", { cause: error });
      }
      pendingCandidate = { endpoint: pending.endpoint, generation: pending.generation, key };
      try {
        await options.onSetupComplete?.(pending.endpoint, key);
        await callbacks.onMessage?.(validation === "validated" ? "OmniRoute endpoint staged; run /cruxomni refresh to activate it." : "OmniRoute endpoint saved as unverified; run /cruxomni refresh when it is reachable.", validation === "validated" ? "info" : "warning");
        return key;
      } catch (error) {
        clearPendingCandidate();
        throw error;
      }
    },
  };
}

/** Resolve native OMP credentials, honoring the atomic environment binding first. */
export async function resolveRuntimeCredential(modelRegistry: ModelRegistryCredentialReader): Promise<string | undefined> {
  const env = resolveEnvironmentBinding();
  if (env) return env.credential.value;
  const value = await modelRegistry.getApiKeyForProvider(PROVIDER_ID);
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

export async function recoverPendingAfterPersistence(
  modelRegistry: ModelRegistryCredentialReader,
  candidateKey?: string,
): Promise<PluginConfig | undefined> {
  const candidate = pendingCandidate;
  if (!candidate || (candidateKey !== undefined && candidate.key !== candidateKey)) {
    clearPendingCandidate();
    return undefined;
  }
  try {
    const config = await loadConfig();
    if (resolveEnvironmentBinding(config)) return undefined;
    const pending = config.pending;
    if (!pending || pending.endpoint !== candidate.endpoint || pending.generation !== candidate.generation) return undefined;
    const persisted = await resolveRuntimeCredential(modelRegistry);
    if (persisted !== candidate.key) return undefined;
    return await commitPendingConfig(
      pending,
      config.revision === undefined ? undefined : { expectedRevision: config.revision },
    );
  } finally {
    // A candidate is single-use. Failed or successful recovery must require a
    // fresh native login rather than allowing a later refresh to self-compare.
    clearPendingCandidate();
  }
}

export function nativeLoginConfig(options: NativeLoginOptions = {}): { oauth: NativeLoginProvider } {
  return { oauth: registerNativeLogin(options) };
}
