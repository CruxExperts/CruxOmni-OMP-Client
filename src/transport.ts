export type TransportErrorCode =
  | "network"
  | "timeout"
  | "aborted"
  | "http"
  | "redirect"
  | "payload-too-large"
  | "depth-limit"
  | "invalid-json"
  | "invalid-endpoint"
  | "budget-exhausted"
  | "body-read";

export class TransportError extends Error {
  readonly name = "TransportError";
  constructor(
    readonly code: TransportErrorCode,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type TransportCredential =
  | string
  | { kind: "apiKey"; value: string }
  | { kind: "cookie"; value: string }
  | { apiKey?: string; cookie?: string };

export interface RequestTarget {
  endpoint: string;
  path?: string;
  method?: string;
  body?: BodyInit | null;
  headers?: HeadersInit;
}

export interface RequestLimits {
  /** Per-attempt cap. Defaults to totalBudgetMs. */
  timeoutMs?: number;
  /** Wall-clock cap across the request and its one permitted retry. */
  totalBudgetMs?: number;
  maxBytes?: number;
  maxDepth?: number;
}

export interface RetryPolicy {
  /** Retries are opt-in and only valid for GET/HEAD safe reads. */
  safeRead?: boolean;
  maxRetries?: number;
  retryStatuses?: readonly number[];
  retryAfterCapMs?: number;
}

const DEFAULT_TOTAL_BUDGET = 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 24;
const DEFAULT_RETRY_STATUSES = [429, 502, 503, 504] as const;

interface NormalizedTarget {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
  headers: HeadersInit | undefined;
}

function validPositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizeTarget(target: string | RequestTarget): NormalizedTarget {
  const source = typeof target === "string" ? { endpoint: target } : target;
  let url: URL;
  try { url = new URL(source.endpoint); } catch (error) { throw new TransportError("invalid-endpoint", "request endpoint is not a URL", undefined, undefined, { cause: error }); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TransportError("invalid-endpoint", "request endpoint protocol must be HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new TransportError("invalid-endpoint", "request endpoint contains forbidden URL components");
  if (url.pathname.includes("..")) throw new TransportError("invalid-endpoint", "request endpoint path traversal is forbidden");
  if (source.path !== undefined) {
    if (!source.path.startsWith("/") || source.path.includes("..") || /[?#]/.test(source.path)) throw new TransportError("invalid-endpoint", "request path is invalid");
    const prefix = url.pathname.replace(/\/+$/, "");
    url.pathname = `${prefix}${source.path}` || "/";
  }
  return { url: url.toString(), method: (source.method ?? "GET").toUpperCase(), body: source.body, headers: source.headers };
}

function credentialHeaders(credential: TransportCredential | undefined): Headers {
  const headers = new Headers();
  if (!credential) return headers;
  if (typeof credential === "string") {
    if (credential) headers.set("Authorization", `Bearer ${credential}`);
    return headers;
  }
  if ("kind" in credential) {
    if (credential.kind === "apiKey") {
      if (credential.value) headers.set("Authorization", `Bearer ${credential.value}`);
      return headers;
    }
    if (credential.value) headers.set("Cookie", credential.value);
    return headers;
  }
  if (credential.apiKey) headers.set("Authorization", `Bearer ${credential.apiKey}`);
  if (credential.cookie) headers.set("Cookie", credential.cookie);
  return headers;
}

function mergedHeaders(input: HeadersInit | undefined, credential: TransportCredential | undefined, hasBody: boolean): Headers {
  const headers = credentialHeaders(credential);
  if (input) new Headers(input).forEach((value, key) => headers.set(key, value));
  if (hasBody && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return headers;
}

function retryableStatus(status: number, policy: RetryPolicy): boolean {
  const statuses = policy.retryStatuses ?? DEFAULT_RETRY_STATUSES;
  return statuses.includes(status) && status !== 401 && status !== 403;
}

function parseRetryAfter(response: Response, capMs: number): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return 0;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(capMs, Math.floor(seconds * 1000));
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return 0;
  return Math.min(capMs, Math.max(0, date - Date.now()));
}

function abortReason(signal: AbortSignal | undefined, timedOut: boolean): TransportError {
  if (signal?.aborted) return new TransportError("aborted", "request cancelled");
  if (timedOut) return new TransportError("timeout", "request timed out");
  return new TransportError("network", "request failed");
}

function validateDepth(value: unknown, maxDepth: number, depth = 0, seen = new Set<object>()): void {
  if (depth > maxDepth) throw new TransportError("depth-limit", "JSON response exceeds maximum depth");
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new TransportError("depth-limit", "JSON response contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) validateDepth(child, maxDepth, depth + 1, seen);
  } else {
    for (const child of Object.values(value)) validateDepth(child, maxDepth, depth + 1, seen);
  }
  seen.delete(value);
}

async function readBody(response: Response, maxBytes: number, signal: AbortSignal, timedOut: () => boolean): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) throw new TransportError("payload-too-large", "response exceeds byte limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new TransportError(timedOut() ? "timeout" : "aborted", timedOut() ? "request timed out" : "request cancelled");
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TransportError("payload-too-large", "response exceeds byte limit");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof TransportError) throw error;
    if (timedOut()) throw new TransportError("timeout", "request timed out", undefined, undefined, { cause: error });
    if (signal.aborted) throw new TransportError("aborted", "request cancelled");
    throw new TransportError("body-read", "unable to read response body", undefined, undefined, { cause: error });
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}
function parseJson(bytes: Uint8Array, maxDepth: number): unknown {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch (error) { throw new TransportError("invalid-json", "response is not valid JSON", undefined, undefined, { cause: error }); }
  validateDepth(value, maxDepth);
  return value;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const stop = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(new TransportError("aborted", "request cancelled"));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

function wrapBody(response: Response, maxBytes: number, signal: AbortSignal, cleanup: () => void, timedOut: () => boolean): Response {
  if (!response.body) { cleanup(); return response; }
  const reader = response.body.getReader();
  let total = 0;
  const finish = (): void => { cleanup(); };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) {
        finish();
        controller.error(new TransportError(timedOut() ? "timeout" : "aborted", timedOut() ? "request timed out" : "request cancelled"));
        return;
      }
      try {
        const part = await reader.read();
        if (part.done) { reader.releaseLock(); finish(); controller.close(); return; }
        total += part.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          finish();
          controller.error(new TransportError("payload-too-large", "response exceeds byte limit"));
          return;
        }
        controller.enqueue(part.value);
      } catch (error) {
        finish();
        controller.error(error instanceof TransportError ? error : new TransportError("body-read", "unable to read response body", undefined, undefined, { cause: error }));
      }
    },
    async cancel(reason) { await reader.cancel(reason); finish(); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

type NormalizedLimits = Required<Pick<RequestLimits, "timeoutMs" | "totalBudgetMs" | "maxBytes" | "maxDepth">>;

interface AttemptResult {
  response: Response;
  limits: NormalizedLimits;
  controller: AbortController;
  timedOut(): boolean;
  cleanup(): void;
}


async function attempt(target: NormalizedTarget, credential: TransportCredential | undefined, limits: NormalizedLimits, signal: AbortSignal | undefined, remainingMs: number): Promise<AttemptResult> {
  if (remainingMs <= 0) throw new TransportError("budget-exhausted", "request budget exhausted");
  if (signal?.aborted) throw new TransportError("aborted", "request cancelled");
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = Math.min(limits.timeoutMs, remainingMs);
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const init: RequestInit = {
      method: target.method,
      headers: mergedHeaders(target.headers, credential, target.body !== undefined && target.body !== null),
      redirect: "manual",
      signal: controller.signal,
    };
    if (target.body !== undefined) init.body = target.body;
    const response = await fetch(target.url, init);
    return { response, limits, controller, timedOut: () => timedOut, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
  } catch (error) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (error instanceof TransportError) throw error;
    throw abortReason(signal, timedOut);
  }

}
async function execute(targetInput: string | RequestTarget, credential: TransportCredential | undefined, limitsInput: RequestLimits | undefined, signal: AbortSignal | undefined, policyInput: RetryPolicy | undefined): Promise<AttemptResult> {
  const target = normalizeTarget(targetInput);
  const totalBudgetMs = validPositive(limitsInput?.totalBudgetMs, DEFAULT_TOTAL_BUDGET);
  const limits = {
    timeoutMs: validPositive(limitsInput?.timeoutMs, totalBudgetMs),
    totalBudgetMs,
    maxBytes: validPositive(limitsInput?.maxBytes, DEFAULT_MAX_BYTES),
    maxDepth: validPositive(limitsInput?.maxDepth, DEFAULT_MAX_DEPTH),
  };
  const policy = policyInput ?? {};
  const safeRead = policy.safeRead === true && (target.method === "GET" || target.method === "HEAD");
  const maxRetries = safeRead ? Math.min(1, Math.max(0, policy.maxRetries ?? 1)) : 0;
  const statuses = policy.retryStatuses ?? DEFAULT_RETRY_STATUSES;
  const started = Date.now();
  let retries = 0;
  let lastNetwork: TransportError | undefined;
  while (true) {
    const remaining = totalBudgetMs - (Date.now() - started);
    if (remaining <= 0) throw new TransportError("budget-exhausted", "request budget exhausted", undefined, undefined, { cause: lastNetwork });
    let result: AttemptResult;
    try {
      result = await attempt(target, credential, limits, signal, remaining);
    } catch (error) {
      const transport = error instanceof TransportError ? error : new TransportError("network", "request failed", undefined, undefined, { cause: error });
      if (safeRead && retries < maxRetries && (transport.code === "network" || transport.code === "timeout") && Date.now() - started < totalBudgetMs) {
        retries += 1;
        lastNetwork = transport;
        continue;
      }
      throw transport;
    }
    const { response, controller, cleanup } = result;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      cleanup();
      throw new TransportError("redirect", "authenticated redirects are forbidden", response.status);
    }
    if (!response.ok && safeRead && retries < maxRetries && statuses.includes(response.status) && retryableStatus(response.status, policy)) {
      const retryAfter = parseRetryAfter(response, validPositive(policy.retryAfterCapMs, 2_000));
      await response.body?.cancel();
      cleanup();
      if (retryAfter > totalBudgetMs - (Date.now() - started)) throw new TransportError("budget-exhausted", "retry delay exceeds request budget", response.status, retryAfter);
      await delay(retryAfter, signal ?? new AbortController().signal);
      retries += 1;
      continue;
    }
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel();
      cleanup();
      throw new TransportError("http", `HTTP request failed with status ${status}`, status);
    }
    return { response, limits, controller, timedOut: result.timedOut, cleanup };
  }
}

export async function requestJson(
  endpoint: string | RequestTarget,
  credential?: TransportCredential,
  limits?: RequestLimits,
  signal?: AbortSignal,
  retryPolicy?: RetryPolicy,
): Promise<unknown> {
  const result = await execute(endpoint, credential, limits, signal, retryPolicy);
  try {
    const bytes = await readBody(result.response, result.limits.maxBytes, result.controller.signal, result.timedOut);
    return parseJson(bytes, result.limits.maxDepth);
  } finally {
    result.cleanup();
  }
}

export async function requestStream(
  endpoint: string | RequestTarget,
  credential?: TransportCredential,
  limits?: RequestLimits,
  signal?: AbortSignal,
  retryPolicy?: RetryPolicy,
): Promise<Response> {
  const result = await execute(endpoint, credential, limits, signal, retryPolicy);
  return wrapBody(result.response, result.limits.maxBytes, result.controller.signal, result.cleanup, result.timedOut);
}
