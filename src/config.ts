import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, stat, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";

export const PROVIDER_ID = "omniroute";
export const CONFIG_VERSION = 2 as const;

export type ConfigErrorCode =
  | "invalid-config"
  | "corrupt-config"
  | "insecure-permissions"
  | "config-conflict"
  | "invalid-endpoint"
  | "insecure-http"
  | "environment-partial"
  | "environment-conflict"
  | "pending-mismatch"
  | "no-pending";

export class ConfigError extends Error {
  readonly name = "ConfigError";
  constructor(readonly code: ConfigErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface ActiveBinding {
  endpoint: string;
  generation: number;
}

export interface PendingBinding extends ActiveBinding {
  /** A pending binding is never a credential. It is only an endpoint hand-off marker. */
  status?: "unverified" | "validated";
}

export interface PluginConfig {
  version: typeof CONFIG_VERSION;
  active?: ActiveBinding;
  pending?: PendingBinding;
  allowInsecureHttp: boolean;
  adminEnabled: boolean;
  pricingFile?: string;
  invitationDismissed?: boolean;
  setupDraft?: string;
  optionalCredentials?: Partial<Record<CredentialDomain, CredentialReference>>;
  /** Non-persisted optimistic-concurrency token attached by loadConfig. */
  readonly revision?: string;
}

export type CredentialDomain = "metadata" | "admin";
export interface CredentialReference {
  domain: CredentialDomain;
  endpoint: string;
  generation: number;
  providerKey: string;
  kind: "apiKey" | "cookie";
  state: "pending" | "ready" | "revoked";
  rowId?: number;
}

export interface EnvironmentBinding {
  source: "environment";
  endpoint: string;
  credential: { kind: "apiKey"; value: string };
  generation: number;
  readOnly: true;
}

type PersistedConfig = Omit<PluginConfig, "revision">;

interface ConfigSnapshot {
  config: PluginConfig;
  revision: string | undefined;
}

export interface ConfigWriteOptions {
  expectedRevision?: string | null;
}

const CONFIG_DIR_NAME = "omniroute";
const CONFIG_FILE_NAME = "config.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const ENDPOINT_PATH = /^(?:\/[^?#]*)?$/;

type AgentDirResolver = () => string;

let agentDirResolver: AgentDirResolver = getAgentDir;

/**
 * Override the profile root for isolated tests. Production always delegates to
 * pi-utils' getAgentDir implementation.
 */
export function setAgentDirResolverForTests(resolver: AgentDirResolver | undefined): void {
  agentDirResolver = resolver ?? getAgentDir;
}

function configPath(): string {
  return join(agentDirResolver(), CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

export function getConfigPath(): string {
  return configPath();
}

function attachRevision(config: PluginConfig, revision: string | undefined): PluginConfig {
  if (revision !== undefined) {
    Object.defineProperty(config, "revision", { configurable: true, enumerable: false, value: revision, writable: false });
  }
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new ConfigError("invalid-config", `${field} must be a non-empty string`);
  return value;
}

function validateGeneration(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ConfigError("invalid-config", `${field} must be a positive integer`);
  }
  return value;
}

function validateBinding(value: unknown, field: string, allowInsecureHttp: boolean): PendingBinding | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ConfigError("invalid-config", `${field} must be an object`);
  const endpoint = validateEndpoint(cleanString(value.endpoint, `${field}.endpoint`) ?? "", allowInsecureHttp);
  const generation = validateGeneration(value.generation, `${field}.generation`);
  const status = value.status;
  if (status !== undefined && status !== "unverified" && status !== "validated") {
    throw new ConfigError("invalid-config", `${field}.status is invalid`);
  }
  return status === undefined ? { endpoint, generation } : { endpoint, generation, status };
}

function parseConfig(value: unknown): PersistedConfig {
  if (!isRecord(value) || value.version !== CONFIG_VERSION) throw new ConfigError("corrupt-config", "unsupported or missing config version");
  if (typeof value.allowInsecureHttp !== "boolean" || typeof value.adminEnabled !== "boolean") {
    throw new ConfigError("corrupt-config", "config flags are invalid");
  }
  const allowInsecureHttp = value.allowInsecureHttp;
  const active = validateBinding(value.active, "active", allowInsecureHttp);
  const pending = validateBinding(value.pending, "pending", allowInsecureHttp) as PendingBinding | undefined;
  if (active && pending && pending.generation <= active.generation) {
    throw new ConfigError("corrupt-config", "pending generation must be newer than active generation");
  }
  const pricingFile = cleanString(value.pricingFile, "pricingFile");
  const result: PersistedConfig = {
    version: CONFIG_VERSION,
    allowInsecureHttp,
    adminEnabled: value.adminEnabled,
  };
  if (active) result.active = active;
  if (pending) result.pending = pending;
  if (pricingFile !== undefined) result.pricingFile = pricingFile;
  if (value.invitationDismissed !== undefined) {
    if (typeof value.invitationDismissed !== "boolean") throw new ConfigError("corrupt-config", "invalid invitation state");
    result.invitationDismissed = value.invitationDismissed;
  }
  if (value.setupDraft !== undefined) result.setupDraft = validateEndpoint(cleanString(value.setupDraft, "setupDraft")!, allowInsecureHttp);
  if (value.optionalCredentials !== undefined) {
    if (!isRecord(value.optionalCredentials)) throw new ConfigError("corrupt-config", "invalid credential references");
    result.optionalCredentials = {};
    for (const [domain, candidate] of Object.entries(value.optionalCredentials)) {
      if ((domain !== "metadata" && domain !== "admin") || !isRecord(candidate) || candidate.domain !== domain
        || typeof candidate.providerKey !== "string" || !new RegExp(`^cruxomni-${domain}-[0-9a-f-]{36}$`).test(candidate.providerKey)
        || !["pending", "ready", "revoked"].includes(String(candidate.state))
        || !["apiKey", "cookie"].includes(String(candidate.kind)) || (domain === "metadata" && candidate.kind !== "apiKey")
        || typeof candidate.generation !== "number" || !Number.isSafeInteger(candidate.generation) || candidate.generation < 0
        || (candidate.rowId !== undefined && (typeof candidate.rowId !== "number" || !Number.isSafeInteger(candidate.rowId) || candidate.rowId < 0))
        || (candidate.state === "ready" && candidate.rowId === undefined)) throw new ConfigError("corrupt-config", "invalid credential reference");
      const endpoint = validateEndpoint(cleanString(candidate.endpoint, "credential endpoint")!, allowInsecureHttp);
      result.optionalCredentials[domain] = { domain, endpoint, generation: candidate.generation,
        providerKey: candidate.providerKey, kind: candidate.kind as CredentialReference["kind"], state: candidate.state as CredentialReference["state"],
        ...(candidate.rowId === undefined ? {} : { rowId: candidate.rowId as number }) };
    }
  }
  return result;
}

function defaultConfig(revision?: string): PluginConfig {
  return attachRevision({ version: CONFIG_VERSION, allowInsecureHttp: false, adminEnabled: false }, revision);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRaw(allowOwnedLock = false): Promise<{ bytes: Uint8Array; revision: string } | undefined> {
  const path = configPath();
  let before;
  try {
    const directory = await lstat(join(agentDirResolver(), CONFIG_DIR_NAME));
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) throw new ConfigError("insecure-permissions", "config directory must be private and not a symlink");
    if (!allowOwnedLock) {
      try {
        await lstat(join(agentDirResolver(), CONFIG_DIR_NAME, ".config.lock"));
        throw new ConfigError("config-conflict", "configuration transaction requires reconciliation");
      } catch (error) {
        if (error instanceof ConfigError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o077) !== 0) throw new ConfigError("insecure-permissions", "config must be a private regular file");
    if (before.size > MAX_CONFIG_BYTES) throw new ConfigError("corrupt-config", "config exceeds size limit");
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError("corrupt-config", "unable to inspect config", { cause: error });
  }
  let bytes: Uint8Array;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
  } catch (error) {
    throw new ConfigError("config-conflict", "config changed while reading", { cause: error });
  }
  let after;
  try {
    after = await lstat(path);
  } catch (error) {
    throw new ConfigError("config-conflict", "config changed while reading", { cause: error });
  }
  if (after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length > MAX_CONFIG_BYTES) {
    throw new ConfigError("config-conflict", "config changed while reading");
  }
  return { bytes, revision: digest(bytes) };
}
async function readSnapshot(allowOwnedLock = false): Promise<ConfigSnapshot> {
  const raw = await readRaw(allowOwnedLock);
  if (!raw) return { config: defaultConfig(), revision: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw.bytes));
  } catch (error) {
    throw new ConfigError("corrupt-config", "config is not valid JSON", { cause: error });
  }
  const persisted = parseConfig(parsed);
  const config: PluginConfig = { ...persisted };
  attachRevision(config, raw.revision);
  return { config, revision: raw.revision };
}

export async function loadConfig(): Promise<PluginConfig> {
  return (await readSnapshot()).config;
}

function persisted(config: PluginConfig): PersistedConfig {
  const result: PersistedConfig = {
    version: CONFIG_VERSION,
    allowInsecureHttp: config.allowInsecureHttp,
    adminEnabled: config.adminEnabled,
  };
  if (config.active) result.active = { ...config.active };
  if (config.pending) result.pending = { ...config.pending };
  if (config.pricingFile !== undefined) result.pricingFile = config.pricingFile;
  if (config.invitationDismissed !== undefined) result.invitationDismissed = config.invitationDismissed;
  if (config.setupDraft !== undefined) result.setupDraft = config.setupDraft;
  if (config.optionalCredentials !== undefined) result.optionalCredentials = structuredClone(config.optionalCredentials);
  return result;
}

async function writeConfig(next: PluginConfig, expectedRevision: string | null | undefined): Promise<PluginConfig> {
  await readSnapshot(); // Never repair invalid state implicitly.
  const dir = join(agentDirResolver(), CONFIG_DIR_NAME);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, ".config.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) { throw new ConfigError("config-conflict", "another configuration writer or interrupted write requires reconciliation", { cause: error }); }
  let result: PluginConfig;
  try { result = await writeConfigUnlocked(next, expectedRevision); }
  catch (error) {
    try { await lock.close(); } catch { /* preserve the original failure */ }
    try { await unlink(lockPath); } catch { /* a retained lock fails closed */ }
    throw error;
  }
  let cleanupError: unknown;
  try { await lock.close(); } catch (error) { cleanupError = error; }
  try { await unlink(lockPath); } catch (error) { cleanupError ??= error; }
  if (cleanupError !== undefined) {
    // A committed write with uncertain lock cleanup must remain unusable until
    // an operator reconciles it. Re-create the marker if unlink happened after
    // a close failure so ordinary readers continue to fail closed.
    try { const marker = await open(lockPath, "a", 0o600); await marker.close(); } catch { /* best effort; preserve the cleanup failure */ }
    throw new ConfigError("config-conflict", "configuration committed but transaction cleanup requires reconciliation", { cause: cleanupError });
  }
  return result;
}

async function writeConfigUnlocked(next: PluginConfig, expectedRevision: string | null | undefined): Promise<PluginConfig> {
  parseConfig(persisted(next));
  const current = await readSnapshot(true);
  const effectiveRevision = expectedRevision === undefined ? current.revision : expectedRevision ?? undefined;
  if (effectiveRevision !== current.revision) throw new ConfigError("config-conflict", "config changed concurrently");
  const dir = join(agentDirResolver(), CONFIG_DIR_NAME);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const body = JSON.stringify(persisted(next), null, 2) + "\n";
  const temporary = join(dir, `.config.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    const latest = await readRaw(true);
    if ((latest?.revision) !== effectiveRevision) throw new ConfigError("config-conflict", "config changed concurrently");
    await chmod(temporary, 0o600);
    await rename(temporary, configPath());
  } catch (error) {
    try { await handle?.close(); } catch { /* best effort cleanup */ }
    try { await unlink(temporary); } catch { /* best effort cleanup */ }
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("config-conflict", "unable to atomically write config", { cause: error });
  }
  const revision = digest(new TextEncoder().encode(body));
  return attachRevision({ ...next }, revision);
}

function revisionOf(config: PluginConfig | undefined, options?: ConfigWriteOptions): string | null | undefined {
  return options?.expectedRevision !== undefined ? options.expectedRevision : config?.revision;
}

function expectedRevision(snapshot: string | undefined, requested: string | null | undefined): string | null {
  return requested === undefined ? snapshot ?? null : requested;
}

/** The sole owner of persisted non-secret setup state. */
export async function updateConfig(change: (current: PluginConfig) => PluginConfig, options: ConfigWriteOptions = {}): Promise<PluginConfig> {
  const current = await loadConfig();
  return writeConfig(change(current), options.expectedRevision === undefined ? current.revision ?? null : options.expectedRevision);
}

export function validateEndpoint(input: string, allowInsecureHttp = false): string {
  if (typeof input !== "string" || input.trim() !== input || input.length === 0 || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new ConfigError("invalid-endpoint", "endpoint must be a trimmed URL");
  }
  const authorityMarker = input.indexOf("://");
  const authorityTail = authorityMarker >= 0 ? input.slice(authorityMarker + 3) : "";
  const slash = authorityTail.indexOf("/");
  const rawPath = slash >= 0 ? (authorityTail.slice(slash).split(/[?#]/, 1)[0] ?? "") : "/";
  let rawDecodedPath: string;
  try { rawDecodedPath = decodeURIComponent(rawPath); } catch (error) { throw new ConfigError("invalid-endpoint", "endpoint path encoding is invalid", { cause: error }); }
  if (rawDecodedPath.split("/").some((part) => part === "." || part === "..")) {
    throw new ConfigError("invalid-endpoint", "endpoint path is invalid");
  }
  let url: URL;
  try { url = new URL(input); } catch (error) { throw new ConfigError("invalid-endpoint", "endpoint is not a URL", { cause: error }); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError("invalid-endpoint", "endpoint protocol must be HTTP or HTTPS");
  if (url.username || url.password) throw new ConfigError("invalid-endpoint", "endpoint userinfo is forbidden");
  if (url.search || url.hash) throw new ConfigError("invalid-endpoint", "endpoint query and fragment are forbidden");
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(url.pathname); } catch (error) { throw new ConfigError("invalid-endpoint", "endpoint path encoding is invalid", { cause: error }); }
  if (!url.hostname || !ENDPOINT_PATH.test(url.pathname) || decodedPath.split("/").some((part) => part === ".." || part === ".")) {
    throw new ConfigError("invalid-endpoint", "endpoint path is invalid");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname) && !allowInsecureHttp) {
    throw new ConfigError("insecure-http", "remote HTTP requires an explicit saved interactive warning");
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "/v1") pathname = "";
  else if (pathname.endsWith("/v1")) pathname = pathname.slice(0, -3).replace(/\/+$/, "");
  url.pathname = pathname || "/";
  return url.toString().replace(/\/$/, "");
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "localhost.localdomain" || host === "::1") return true;
  const ipv4 = host.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) {
    return Number(ipv4[0]) === 127;
  }
  return false;
}

export function endpointUrl(endpoint: string, path: string): string {
  const root = validateEndpoint(endpoint, true);
  if (!path.startsWith("/v1/") && path !== "/v1") throw new ConfigError("invalid-endpoint", "request path must be under /v1");
  if (path.includes("..") || /[?#]/.test(path)) throw new ConfigError("invalid-endpoint", "request path is invalid");
  return `${root}${path}`;
}

export async function savePendingConfig(
  pendingOrConfig: string | PendingBinding | PluginConfig,
  options?: ConfigWriteOptions,
): Promise<PluginConfig> {
  const current = await readSnapshot();
  const sourceConfig = typeof pendingOrConfig === "object" && "version" in pendingOrConfig ? pendingOrConfig : undefined;
  const expected = expectedRevision(current.revision, revisionOf(sourceConfig, options));
  if ((expected ?? undefined) !== current.revision) throw new ConfigError("config-conflict", "config changed concurrently");
  const next: PluginConfig = { ...current.config };
  let pending: PendingBinding;
  if (typeof pendingOrConfig === "string") {
    const endpoint = validateEndpoint(pendingOrConfig, current.config.allowInsecureHttp);
    pending = { endpoint, generation: (current.config.active?.generation ?? 0) + 1, status: "validated" };
  } else if ("version" in pendingOrConfig) {
    const requested = pendingOrConfig.pending;
    if (!requested) throw new ConfigError("pending-mismatch", "pending binding is required");
    pending = {
      endpoint: validateEndpoint(requested.endpoint, pendingOrConfig.allowInsecureHttp),
      generation: requested.generation,
      ...(requested.status ? { status: requested.status } : {}),
    };
    next.allowInsecureHttp = pendingOrConfig.allowInsecureHttp;
    next.adminEnabled = pendingOrConfig.adminEnabled;
    if (pendingOrConfig.pricingFile === undefined) delete next.pricingFile;
    else next.pricingFile = pendingOrConfig.pricingFile;
  } else {
    pending = { endpoint: validateEndpoint(pendingOrConfig.endpoint, current.config.allowInsecureHttp), generation: pendingOrConfig.generation, ...(pendingOrConfig.status ? { status: pendingOrConfig.status } : {}) };
  }
  if (!Number.isSafeInteger(pending.generation) || pending.generation < (current.config.active?.generation ?? 0) + 1) {
    throw new ConfigError("pending-mismatch", "pending generation must be newer than active generation");
  }
  next.pending = pending;
  return writeConfig(next, expected);
}

export async function commitPendingConfig(
  candidate?: ActiveBinding | string,
  options?: ConfigWriteOptions,
): Promise<PluginConfig> {
  const current = await readSnapshot();
  const expected = expectedRevision(current.revision, revisionOf(undefined, options));
  if ((expected ?? undefined) !== current.revision) throw new ConfigError("config-conflict", "config changed concurrently");
  const pending = current.config.pending;
  if (!pending) throw new ConfigError("no-pending", "no pending endpoint exists");
  if (candidate !== undefined) {
    const endpoint = typeof candidate === "string" ? validateEndpoint(candidate, current.config.allowInsecureHttp) : validateEndpoint(candidate.endpoint, current.config.allowInsecureHttp);
    const generation = typeof candidate === "string" ? pending.generation : candidate.generation;
    if (endpoint !== pending.endpoint || generation !== pending.generation) throw new ConfigError("pending-mismatch", "pending endpoint does not match candidate");
  }
  const next: PluginConfig = { ...current.config, active: { endpoint: pending.endpoint, generation: pending.generation } };
  delete next.pending;
  return writeConfig(next, expected);
}

export async function clearPendingConfig(options?: ConfigWriteOptions): Promise<PluginConfig> {
  const current = await readSnapshot();
  const expected = expectedRevision(current.revision, revisionOf(undefined, options));
  if ((expected ?? undefined) !== current.revision) throw new ConfigError("config-conflict", "config changed concurrently");
  const next: PluginConfig = { ...current.config };
  delete next.pending;
  return writeConfig(next, expected);
}

/** Persist only the administration enablement flag without changing runtime bindings. */
export async function setAdminEnabledConfig(enabled: boolean, options?: ConfigWriteOptions): Promise<PluginConfig> {
  const current = await readSnapshot();
  const expected = expectedRevision(current.revision, options?.expectedRevision);
  if ((expected ?? undefined) !== current.revision) throw new ConfigError("config-conflict", "config changed concurrently");
  return writeConfig({ ...current.config, adminEnabled: enabled }, expected);
}

export function resolveEnvironmentBinding(config?: Pick<PluginConfig, "allowInsecureHttp">): EnvironmentBinding | undefined {
  const key = process.env.OMP_OMNIROUTE_API_KEY?.trim() || undefined;
  const preferredUrl = process.env.OMP_OMNIROUTE_BASE_URL?.trim() || undefined;
  const hasKey = key !== undefined;
  const hasUrl = preferredUrl !== undefined;
  if (hasKey !== hasUrl) throw new ConfigError("environment-partial", "environment binding requires both API key and base URL");
  if (!hasKey || !key) return undefined;
  const endpoint = validateEndpoint(preferredUrl ?? "", config?.allowInsecureHttp ?? false);
  return { source: "environment", endpoint, credential: { kind: "apiKey", value: key }, generation: 0, readOnly: true };
}
