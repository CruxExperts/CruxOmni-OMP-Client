import { dirname, isAbsolute, resolve } from "node:path";
import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";

/** Limits are deliberately small enough for an interactive administration session. */
export const ADMIN_ADAPTER_LIMITS = {

timeoutMs: 30_000,
maxResponseBytes: 8 * 1024 * 1024,
maxRequestBytes: 8 * 1024 * 1024,
maxFileBytes: 64 * 1024 * 1024,
maxSseEvents: 1_000,
maxSseBytes: 8 * 1024 * 1024,
maxJobPolls: 120,
maxJobDurationMs: 10 * 60 * 1_000,
maxWebSocketMessages: 1_000,
maxWebSocketBytes: 8 * 1024 * 1024,
} as const;

export type ProgressUpdate = {
  phase: "request" | "upload" | "download" | "stream" | "poll" | "cancel";
  completed?: number;
  total?: number;
  message?: string;
};

export type AdapterErrorCode =
  | "invalid_endpoint"
  | "remote_endpoint_not_allowed"
  | "invalid_route"
  | "invalid_path"
  | "invalid_payload"
  | "body_too_large"
  | "timeout"
  | "cancelled"
  | "redirect_not_allowed"
  | "unsupported_protocol"
  | "file_not_allowed"
  | "file_too_large"
  | "symlink_not_allowed"
  | "destination_exists"
  | "operator_required"
  | "job_timeout"
  | "local_process_not_allowed"
  | "adapter_unavailable"
  | "request_failed";

export class AdminAdapterError extends Error {
  readonly name = "AdminAdapterError";
  constructor(readonly code: AdapterErrorCode, message: string, readonly status?: number, options?: ErrorOptions) {
    super(message, options);
  }
}

export type AdminCredential =
  | { kind: "apiKey"; value: string }
  | { kind: "cookie"; value: string };

/** A descriptor is supplied by the closed registry; callers cannot choose an arbitrary route. */
export interface RegisteredOperation {
  readonly operationId: string;
  readonly adapterId: string | null;
  readonly method: string;
  readonly pathTemplate: string;
  readonly mediaType?: { request?: string | null; response: string };
  readonly streaming?: { mode: "json" | "sse" | "websocket" | "binary"; framing: string };
  readonly auth?: { domain: string; scopes: readonly string[] };
}

export interface AdapterInvocation {
  readonly descriptor: RegisteredOperation;
  readonly endpoint: string;
  readonly credential?: AdminCredential;
  readonly path?: Readonly<Record<string, string>>;
  /** Already-built path from the closed registry; never supplied by model-authored URLs. */
  readonly resolvedPath?: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly onProgress?: (update: ProgressUpdate) => void;
  /** Only explicitly registered loopback operations may set this. */
  readonly requireLoopback?: boolean;
}

export type AdapterResponse = {
  status: number;
  headers: Record<string, string>;
  data?: unknown;
};

export type ExternalConsentStatus = {
  status: "operator-required";
  reason: "external-consent" | "browser-auth" | "device-auth";
  authorizationUrl?: string;
  message: string;
};

export type AdapterResult<T = AdapterResponse> = T | ExternalConsentStatus;

function safeString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AdminAdapterError("invalid_payload", `${field} is invalid`);
  }
  return value;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/[\[\]]/g, "");
  if (normalized === "localhost" || normalized === "localhost.localdomain" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets.every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
    && Number(octets[0]) === 127;
}

export function validateAdminEndpoint(input: string, requireLoopback = false): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new AdminAdapterError("invalid_endpoint", "administration endpoint is not a URL", undefined, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new AdminAdapterError("invalid_endpoint", "administration endpoint must use HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new AdminAdapterError("invalid_endpoint", "administration endpoint must not contain credentials, query, or fragment");
  if (requireLoopback && !isLoopbackHostname(url.hostname)) throw new AdminAdapterError("remote_endpoint_not_allowed", "this operation is available only on a loopback endpoint");
  return url;
}

function ensureDescriptor(descriptor: RegisteredOperation): void {
  if (!descriptor || typeof descriptor.operationId !== "string" || !descriptor.operationId || typeof descriptor.adapterId !== "string") {
    throw new AdminAdapterError("invalid_route", "operation is not a closed, invokable descriptor");
  }
  if (!/^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/.test(descriptor.method)) throw new AdminAdapterError("invalid_route", "operation method is not allowed");
  if (!/^\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z0-9._~-]+\})(?:\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z0-9._~-]+\}))*$/.test(descriptor.pathTemplate)) throw new AdminAdapterError("invalid_route", "operation path template is not valid");
  if (!descriptor.adapterId.startsWith("typed.")) throw new AdminAdapterError("adapter_unavailable", "operation has no typed adapter");
}

function buildUrl(invocation: AdapterInvocation): URL {
  ensureDescriptor(invocation.descriptor);
  const endpoint = validateAdminEndpoint(invocation.endpoint, invocation.requireLoopback ?? invocation.descriptor.auth?.domain === "local");
  const path = invocation.resolvedPath ?? invocation.descriptor.pathTemplate.replace(/\{([A-Za-z0-9._~-]+)\}/g, (_match, name: string) => {
    const value = invocation.path?.[name];
    if (value === undefined || value.length === 0 || /[\\/\u0000-\u001f\u007f]/.test(value)) throw new AdminAdapterError("invalid_path", `missing or invalid path parameter ${name}`);
    return encodeURIComponent(value);
  });
  if (/\{[^}]+\}/.test(path) || !path.startsWith("/") || /[\u0000-\u001f\u007f]/.test(path)) throw new AdminAdapterError("invalid_path", "unresolved or unsafe operation path");
  const templateSegments = invocation.descriptor.pathTemplate.split("/").slice(1);
  const pathSegments = path.split("/").slice(1);
  if (templateSegments.length !== pathSegments.length) throw new AdminAdapterError("invalid_path", "resolved path does not match the approved operation");
  for (let index = 0; index < templateSegments.length; index++) {
    const template = templateSegments[index]!;
    const segment = pathSegments[index]!;
    if (!/^\{[^}]+\}$/.test(template) && segment !== template) throw new AdminAdapterError("invalid_path", "resolved path changed an approved literal segment");
    if (/^\{[^}]+\}$/.test(template)) {
      let decoded = segment;
      for (let boundary = 0; boundary < 2; boundary++) {
        if (decoded === "." || decoded === ".." || /[\\/]/.test(decoded)) throw new AdminAdapterError("invalid_path", "resolved path contains traversal");
        try { decoded = decodeURIComponent(decoded); } catch { throw new AdminAdapterError("invalid_path", "resolved path encoding is invalid"); }
      }
      if (decoded === "." || decoded === ".." || /[\\/]/.test(decoded)) throw new AdminAdapterError("invalid_path", "resolved path is ambiguous");
    }
  }
  const endpointPrefix = endpoint.pathname.replace(/\/$/, "");
  const expectedPath = `${endpointPrefix}${path}`;
  endpoint.pathname = expectedPath;
  if (endpoint.pathname !== expectedPath) throw new AdminAdapterError("invalid_path", "resolved path normalized away from the approved operation");
  for (const [key, value] of Object.entries(invocation.query ?? {})) {
    if (value !== undefined) endpoint.searchParams.set(safeString(key, "query key"), String(value));
  }
  return endpoint;
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new AdminAdapterError("timeout", "administration request timed out")), timeoutMs);
  const abort = () => controller.abort(signal?.reason ?? new AdminAdapterError("cancelled", "administration request cancelled"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return { signal: controller.signal, dispose: () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); } };
}

function headersFor(credential: AdminCredential | undefined): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (credential?.kind === "apiKey") headers.set("authorization", `Bearer ${credential.value}`);
  if (credential?.kind === "cookie") headers.set("cookie", credential.value);
  return headers;
}

async function readBounded(
  response: Response,
  maxBytes: number,
  onProgress?: (update: ProgressUpdate) => void,
  signal?: AbortSignal,
  callerSignal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new AdminAdapterError("body_too_large", "response exceeds the bounded size limit", response.status);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancelReader = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  if (signal?.aborted) cancelReader();
  else signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new AdminAdapterError("body_too_large", "response exceeds the bounded size limit", response.status);
      chunks.push(next.value);
      onProgress?.({ phase: "download", completed: bytes, ...(declared > 0 ? { total: declared } : {}) });
    }
  } catch (error) {
    if (signal?.aborted) {
      throw new AdminAdapterError(
        callerSignal?.aborted ? "cancelled" : "timeout",
        callerSignal?.aborted ? "administration request cancelled" : "administration request timed out",
        undefined,
        { cause: error },
      );
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  if (signal?.aborted) {
    throw new AdminAdapterError(
      callerSignal?.aborted ? "cancelled" : "timeout",
      callerSignal?.aborted ? "administration request cancelled" : "administration request timed out",
    );
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

type FetchLifetime = {
  readonly response: Response;
  readonly signal: AbortSignal;
  readonly dispose: () => void;
};

async function fetchTyped(invocation: AdapterInvocation, requestBody?: BodyInit, requestHeaders?: Headers): Promise<FetchLifetime> {
  const url = buildUrl(invocation);
  const headers = requestHeaders ?? headersFor(invocation.credential);
  const lifetime = combinedSignal(invocation.signal, ADMIN_ADAPTER_LIMITS.timeoutMs);
  invocation.onProgress?.({ phase: "request", message: `${invocation.descriptor.method} ${invocation.descriptor.pathTemplate}` });
  try {
    const init: RequestInit = { method: invocation.descriptor.method, headers, redirect: "error", signal: lifetime.signal };
    if (requestBody !== undefined) init.body = requestBody;
    const response = await fetch(url, init);
    if (response.type === "opaqueredirect") throw new AdminAdapterError("redirect_not_allowed", "redirects are not allowed for administration requests", response.status);
    return { response, signal: lifetime.signal, dispose: lifetime.dispose };
  } catch (error) {
    lifetime.dispose();
    if (lifetime.signal.aborted) {
      if (invocation.signal?.aborted) throw new AdminAdapterError("cancelled", "administration request cancelled", undefined, { cause: error });
      throw new AdminAdapterError("timeout", "administration request timed out", undefined, { cause: error });
    }
    if (error instanceof AdminAdapterError) throw error;
    throw new AdminAdapterError("request_failed", "administration request failed", undefined, { cause: error });
  }
}

async function readValidatedFile(path: string, maxBytes: number): Promise<Uint8Array> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new AdminAdapterError("file_not_allowed", "input is not a regular file");
    if (info.size > maxBytes) throw new AdminAdapterError("file_too_large", "input exceeds the bounded file size");
    const bytes = new Uint8Array(info.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (bytesRead === 0) throw new AdminAdapterError("file_not_allowed", "input changed while it was being read");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!after.isFile()) throw new AdminAdapterError("file_not_allowed", "input is not a regular file");
    if (after.size > maxBytes || after.size !== info.size) throw new AdminAdapterError("file_not_allowed", "input changed while it was being read");
    return bytes;
  } catch (error) {
    if (error instanceof AdminAdapterError) throw error;
    throw new AdminAdapterError("file_not_allowed", "file cannot be read", undefined, { cause: error });
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function multipartFilename(value: string | undefined, path: string): string {
  const filename = value ?? path.split("/").pop() ?? "upload.bin";
  if (filename.length === 0 || filename.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(filename)) {
    throw new AdminAdapterError("invalid_payload", "multipart filename is invalid");
  }
  return filename;
}

function multipartContentType(value: string | undefined): string {
  const contentType = value ?? "application/octet-stream";
  if (contentType.length === 0 || contentType.length > 256 || /[\u0000-\u001f\u007f]/.test(contentType) || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$/.test(contentType)) {
    throw new AdminAdapterError("invalid_payload", "multipart content type is invalid");
  }
  return contentType;
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return undefined;
  try {
    const text = new TextDecoder().decode(bytes);
    const value = JSON.parse(text);
    const visit = (node: unknown, depth: number): void => {
      if (depth > 24) throw new AdminAdapterError("invalid_payload", "response JSON is too deeply nested");
      if (Array.isArray(node)) for (const item of node) visit(item, depth + 1);
      else if (node && typeof node === "object") for (const item of Object.values(node)) visit(item, depth + 1);
    };
    visit(value, 0);
    return value;
  } catch (error) {
    if (error instanceof AdminAdapterError) throw error;
    throw new AdminAdapterError("request_failed", "response was not valid JSON", undefined, { cause: error });
  }
}


export async function invokeJsonAdapter(invocation: AdapterInvocation): Promise<AdapterResponse> {
  const body = invocation.body === undefined ? undefined : JSON.stringify(invocation.body);
  if (body && new TextEncoder().encode(body).byteLength > ADMIN_ADAPTER_LIMITS.maxRequestBytes) throw new AdminAdapterError("body_too_large", "request exceeds the bounded size limit");
  const headers = headersFor(invocation.credential);
  if (body) headers.set("content-type", "application/json");
  const lifetime = await fetchTyped(invocation, body, headers);
  try {
    const bytes = await readBounded(lifetime.response, ADMIN_ADAPTER_LIMITS.maxResponseBytes, invocation.onProgress, lifetime.signal, invocation.signal);
    return { status: lifetime.response.status, headers: Object.fromEntries(lifetime.response.headers.entries()), data: parseJson(bytes) };
  } finally {
    lifetime.dispose();
  }
}

export type MultipartFile = { field: string; path: string; filename?: string; contentType?: string };

export async function invokeMultipartAdapter(invocation: AdapterInvocation, files: readonly MultipartFile[], fields: Readonly<Record<string, string>> = {}): Promise<AdapterResponse> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(safeString(key, "multipart field"), safeString(value, key));
  for (const file of files) {
    const field = safeString(file.field, "multipart field");
    const path = await validateReadableFile(file.path, ADMIN_ADAPTER_LIMITS.maxFileBytes);
    const bytes = await readValidatedFile(path, ADMIN_ADAPTER_LIMITS.maxFileBytes);
    form.append(field, new Blob([bytes], { type: multipartContentType(file.contentType) }), multipartFilename(file.filename, path));
    invocation.onProgress?.({ phase: "upload", completed: bytes.byteLength, total: bytes.byteLength });
  }
  const lifetime = await fetchTyped(invocation, form, headersFor(invocation.credential));
  try {
    const bytes = await readBounded(lifetime.response, ADMIN_ADAPTER_LIMITS.maxResponseBytes, invocation.onProgress, lifetime.signal, invocation.signal);
    return { status: lifetime.response.status, headers: Object.fromEntries(lifetime.response.headers.entries()), data: parseJson(bytes) };
  } finally {
    lifetime.dispose();
  }
}

export async function invokeBinaryAdapter(invocation: AdapterInvocation, destination?: string): Promise<AdapterResponse> {
  const lifetime = await fetchTyped(invocation, undefined, headersFor(invocation.credential));
  try {
    const bytes = await readBounded(lifetime.response, ADMIN_ADAPTER_LIMITS.maxFileBytes, invocation.onProgress, lifetime.signal, invocation.signal);
    if (destination !== undefined) await writeProtectedFile(destination, bytes);
    return { status: lifetime.response.status, headers: Object.fromEntries(lifetime.response.headers.entries()), data: destination === undefined ? bytes : { destination, bytes: bytes.byteLength } };
  } finally {
    lifetime.dispose();
  }
}

export async function invokeSseAdapter(invocation: AdapterInvocation): Promise<AdapterResponse> {
  const lifetime = await fetchTyped(invocation, undefined, headersFor(invocation.credential));
  try {
    const bytes = await readBounded(lifetime.response, ADMIN_ADAPTER_LIMITS.maxSseBytes, invocation.onProgress, lifetime.signal, invocation.signal);
    const text = new TextDecoder().decode(bytes);
    const events: Array<{ event?: string; data: string; id?: string }> = [];
    let current: { event?: string; data: string[]; id?: string } = { data: [] };
    for (const line of text.split(/\r?\n/)) {
      if (line === "") {
        if (current.data.length > 0) {
          events.push({
            data: current.data.join("\n"),
            ...(current.event === undefined ? {} : { event: current.event }),
            ...(current.id === undefined ? {} : { id: current.id }),
          });
        }
        if (events.length > ADMIN_ADAPTER_LIMITS.maxSseEvents) throw new AdminAdapterError("body_too_large", "SSE event limit exceeded", lifetime.response.status);
        current = { data: [] };
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") current.event = value.slice(0, 200);
      else if (field === "data") current.data.push(value.slice(0, ADMIN_ADAPTER_LIMITS.maxSseBytes));
      else if (field === "id") current.id = value.slice(0, 200);
    }
    return { status: lifetime.response.status, headers: Object.fromEntries(lifetime.response.headers.entries()), data: { events } };
  } finally {
    lifetime.dispose();
  }
}

export type WebSocketFactory = (url: string, options: { headers: Record<string, string> }) => WebSocket;

export async function invokeWebSocketAdapter(invocation: AdapterInvocation, factory: WebSocketFactory = (url, options) => {
  const HeaderWebSocket = WebSocket as unknown as new (target: string, init: { headers: Record<string, string> }) => WebSocket;
  return new HeaderWebSocket(url, options);
}): Promise<AdapterResponse> {
  const endpoint = validateAdminEndpoint(invocation.endpoint, invocation.requireLoopback ?? invocation.descriptor.auth?.domain === "local");
  const httpUrl = buildUrl({ ...invocation, endpoint: endpoint.toString() });
  httpUrl.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  const url = httpUrl.toString();
  if (!invocation.credential) throw new AdminAdapterError("request_failed", "WebSocket administration requires the bound management credential");
  const socket = factory(url, { headers: Object.fromEntries(headersFor(invocation.credential).entries()) });
  const messages: unknown[] = [];
  let bytes = 0;
  return await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); invocation.signal?.removeEventListener("abort", cancel); };
    const timeout = setTimeout(() => { socket.close(); cleanup(); reject(new AdminAdapterError("timeout", "WebSocket administration request timed out")); }, ADMIN_ADAPTER_LIMITS.timeoutMs);
    const cancel = () => { socket.close(); cleanup(); reject(new AdminAdapterError("cancelled", "WebSocket administration request cancelled")); };
    if (invocation.signal?.aborted) cancel(); else invocation.signal?.addEventListener("abort", cancel, { once: true });
    socket.onopen = () => {
      if (invocation.body !== undefined) socket.send(JSON.stringify(invocation.body));
    };
    socket.onmessage = event => {
      const text = typeof event.data === "string" ? event.data : "";
      bytes += text.length;
      if (bytes > ADMIN_ADAPTER_LIMITS.maxWebSocketBytes || messages.length >= ADMIN_ADAPTER_LIMITS.maxWebSocketMessages) {
        socket.close(); cleanup(); reject(new AdminAdapterError("body_too_large", "WebSocket response exceeds the bounded limit")); return;
      }
      messages.push(text);
      invocation.onProgress?.({ phase: "stream", completed: messages.length, total: ADMIN_ADAPTER_LIMITS.maxWebSocketMessages });
    };
    socket.onerror = () => { socket.close(); cleanup(); reject(new AdminAdapterError("request_failed", "WebSocket administration request failed")); };
    socket.onclose = event => { cleanup(); if (event.code >= 4000) reject(new AdminAdapterError("request_failed", "WebSocket administration request closed")); else resolve({ status: 200, headers: {}, data: { messages } }); };
  });
}

export function requestExternalConsent(reason: ExternalConsentStatus["reason"], message: string, authorizationUrl?: string): ExternalConsentStatus {
  return { status: "operator-required", reason, message: message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500), ...(authorizationUrl ? { authorizationUrl: authorizationUrl.slice(0, 2_000) } : {}) };
}

export type JobHandle = { id: string; status: "queued" | "running" | "complete" | "failed" | "cancelled" };
export type JobPoller = (handle: JobHandle, signal: AbortSignal) => Promise<JobHandle & { result?: unknown; error?: string }>;

export async function runBoundedJob(start: () => Promise<JobHandle>, poll: JobPoller, signal?: AbortSignal, onProgress?: (update: ProgressUpdate) => void): Promise<JobHandle & { result?: unknown; error?: string }> {
  const started = Date.now();
  let handle = await start();
  if (!handle.id || !/^[A-Za-z0-9._:-]{1,200}$/.test(handle.id)) throw new AdminAdapterError("invalid_payload", "job returned an invalid identifier");
  for (let attempt = 0; attempt < ADMIN_ADAPTER_LIMITS.maxJobPolls; attempt++) {
    if (signal?.aborted) throw new AdminAdapterError("cancelled", "job polling cancelled");
    if (Date.now() - started > ADMIN_ADAPTER_LIMITS.maxJobDurationMs) throw new AdminAdapterError("job_timeout", "job exceeded its bounded duration");
    if (handle.status === "complete" || handle.status === "failed" || handle.status === "cancelled") return handle;
    onProgress?.({ phase: "poll", completed: attempt + 1, total: ADMIN_ADAPTER_LIMITS.maxJobPolls, message: `job ${handle.id}` });
    await new Promise(resolve => setTimeout(resolve, Math.min(1_000, 100 + attempt * 25)));
    handle = await poll(handle, signal ?? new AbortController().signal);
  }
  throw new AdminAdapterError("job_timeout", "job exceeded its bounded polling limit");
}

export type LocalProcessRunner = (programId: string, args: readonly string[], signal: AbortSignal, onProgress?: (update: ProgressUpdate) => void) => Promise<{ code: number; output?: string }>;

export async function invokeLocalProcessAdapter(programId: string, args: readonly string[], runner: LocalProcessRunner, signal?: AbortSignal, onProgress?: (update: ProgressUpdate) => void): Promise<AdapterResponse> {
  if (!/^[a-z][a-z0-9._-]{0,80}$/.test(programId) || args.some(arg => typeof arg !== "string" || /[\u0000\r\n]/.test(arg))) throw new AdminAdapterError("local_process_not_allowed", "local process is not an allowlisted program invocation");
  if (args.some(arg => /(?:^|\/)\.\.(?:\/|$)/.test(arg))) throw new AdminAdapterError("local_process_not_allowed", "local process arguments may not traverse paths");
  const result = await runner(programId, args, signal ?? new AbortController().signal, update => {
    update.message = "local process progress";
    onProgress?.(update);
  });
  return { status: result.code === 0 ? 200 : 502, headers: {}, data: { code: result.code, output: result.output?.slice(0, 8_000) } };
}

export async function validateReadableFile(input: string, maxBytes = ADMIN_ADAPTER_LIMITS.maxFileBytes): Promise<string> {
  if (!isAbsolute(input) || /[\u0000\r\n]/.test(input)) throw new AdminAdapterError("file_not_allowed", "file paths must be absolute and free of control characters");
  const path = resolve(input);
  const info = await lstat(path).catch((error: unknown) => { throw new AdminAdapterError("file_not_allowed", "file cannot be inspected", undefined, { cause: error }); });
  if (info.isSymbolicLink()) throw new AdminAdapterError("symlink_not_allowed", "symbolic-link input is not allowed");
  if (!info.isFile()) throw new AdminAdapterError("file_not_allowed", "input is not a regular file");
  if (info.size > maxBytes) throw new AdminAdapterError("file_too_large", "input exceeds the bounded file size");
  return path;
}

export async function writeProtectedFile(input: string, bytes: Uint8Array): Promise<string> {
  if (!isAbsolute(input) || /[\u0000\r\n]/.test(input)) throw new AdminAdapterError("file_not_allowed", "destination must be an absolute path");
  if (bytes.byteLength > ADMIN_ADAPTER_LIMITS.maxFileBytes) throw new AdminAdapterError("file_too_large", "destination payload exceeds the bounded file size");
  const path = resolve(input);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new AdminAdapterError("symlink_not_allowed", "symbolic-link destination is not allowed");
    throw new AdminAdapterError("destination_exists", "destination already exists; refusing overwrite");
  } catch (error) {
    if (error instanceof AdminAdapterError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AdminAdapterError("file_not_allowed", "destination cannot be inspected", undefined, { cause: error });
  }
  const handle = await open(path, "wx", 0o600).catch((error: unknown) => { throw new AdminAdapterError("destination_exists", "destination already exists; refusing overwrite", undefined, { cause: error }); });
  try {
    await handle.write(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

/** Selects only a dedicated protocol adapter for a descriptor from the closed registry. */
export function adapterFor(descriptor: RegisteredOperation): "json" | "multipart" | "binary" | "sse" | "websocket" | "operator-required" {
  ensureDescriptor(descriptor);
  const request = descriptor.mediaType?.request ?? "application/json";
  const response = descriptor.mediaType?.response.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const mode = descriptor.streaming?.mode ?? "json";
  if (mode === "websocket") return "websocket";
  if (/(?:oauth|authorize|device|login)/i.test(descriptor.pathTemplate)) return "operator-required";
  if (mode === "sse") return "sse";
  if (request === "multipart/form-data") return "multipart";
  if (mode === "binary" || response === "application/octet-stream") return "binary";
  return "json";
}
