import { Input } from "@oh-my-pi/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { listCategories, operationRegistry, type OperationAdapter } from "./registry.ts";
import type { AdminCredentialInput, AdminPlanHandle, AdminPreview } from "./types.ts";
import type { AdminExecutor } from "./executor.ts";

const DEFAULT_PROFILE = "omniroute";
type AdminContext = ExtensionContext;

export interface AdminBinding {
  readonly endpoint: string;
  readonly credentialGeneration: number;
}

export interface AdminUiOptions {
  readonly executor: AdminExecutor;
  readonly profileId?: string;
  endpoint?: string;
  credentialGeneration?: number;
  resolveEffectiveEndpoint?: () => Promise<AdminBinding | undefined>;
  syncBinding?: () => Promise<void>;
  onEnable?: (endpoint: string) => Promise<AdminBinding | undefined>;
  onDisable?: () => Promise<void> | void;
}

const planCache = new WeakMap<object, Map<string, AdminPlanHandle>>();

function cachedPlans(options: AdminUiOptions): Map<string, AdminPlanHandle> {
  const existing = planCache.get(options.executor);
  if (existing) return existing;
  const created = new Map<string, AdminPlanHandle>();
  planCache.set(options.executor, created);
  return created;
}
export function rememberAdminPlan(options: AdminUiOptions, plan: AdminPlanHandle): void {
  cachedPlans(options).set(plan.planId, plan);
}
function safeDisplay(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, child) => typeof child === "string" ? child.replace(/[\u0000-\u001f\u007f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`) : child, 2) ?? "[unavailable]";
  } catch {
    return "[unavailable]";
  }
}

function notify(context: AdminContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  context.ui.notify(message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 8_000), type);
}

function hasInteractiveUi(context: AdminContext): boolean {
  return context.hasUI;
}
function credentialFromEnvironment(): { apiKey?: string; cookie?: string } {
  const apiKey = process.env.OMP_OMNIROUTE_ADMIN_API_KEY?.trim();
  const cookie = process.env.OMP_OMNIROUTE_ADMIN_COOKIE?.trim();
  return { ...(apiKey ? { apiKey } : {}), ...(cookie ? { cookie } : {}) };
}

async function askText(context: AdminContext, prompt: string, secret = false): Promise<string | undefined> {
  if (!hasInteractiveUi(context)) return undefined;
  return context.ui.custom<string | undefined>((_tui, _theme, _keybindings, done) => {
    const input = new Input();
    input.prompt = `${prompt}: `;
    input.mask = secret;
    input.onSubmit = value => done(value.length > 0 ? value : undefined);
    input.onEscape = () => done(undefined);
    return input;
  }, { overlay: true });
}

function redactPreview(preview: AdminPreview): string {
  const descriptor = operationRegistry.getOperation(preview.operationId);
  const secretFields = new Set(descriptor?.secrets.inputFields.map(field => field.toLowerCase()) ?? []);
  const redact = (value: unknown, key?: string): unknown => {
    if (key && secretFields.has(key.toLowerCase())) return "[redacted]";
    if (Array.isArray(value)) return value.map(item => redact(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, redact(child, name)]));
    return value;
  };
  return safeDisplay({
    target: preview.target,
    operation: preview.operationId,
    method: preview.method,
    path: preview.pathTemplate,
    resolvedPath: preview.resolvedPath,
    query: preview.query,
    planDigest: preview.planDigest,
    risk: preview.risk,
    sideEffect: preview.sideEffect,
    change: redact(preview.payload),
    consequence: preview.consequence,
    confirmationRequired: preview.confirmationRequired,
  });
}

function rememberCredential(options: AdminUiOptions): void {
  const credential = credentialFromEnvironment();
  if (!credential.apiKey && !credential.cookie) return;
  const input: AdminCredentialInput = {
    profileId: options.profileId ?? DEFAULT_PROFILE,
    endpoint: options.endpoint ?? "",
    credentialGeneration: options.credentialGeneration ?? 1,
    ...(credential.apiKey ? { apiKey: credential.apiKey } : {}),
    ...(credential.cookie ? { cookie: credential.cookie } : {}),
  };
  options.executor.bindCredential(input);
}

async function collectSessionCredential(options: AdminUiOptions, context: AdminContext): Promise<boolean> {
  if (!options.endpoint) return false;
  const bound = options.executor.getCredentialBinding();
  if (bound?.enabled && bound.endpoint === options.endpoint && bound.profileId === (options.profileId ?? DEFAULT_PROFILE)) return true;
  const fromEnvironment = credentialFromEnvironment();
  if (!fromEnvironment.apiKey && !fromEnvironment.cookie) {
    const kind = await askText(context, "Management credential kind (apiKey or cookie)");
    if (!kind || (kind !== "apiKey" && kind !== "cookie")) return false;
    const value = await askText(context, kind === "apiKey" ? "Management API key" : "Management cookie", true);
    if (!value) return false;
    const input: AdminCredentialInput = {
      profileId: options.profileId ?? DEFAULT_PROFILE,
      endpoint: options.endpoint,
      credentialGeneration: options.credentialGeneration ?? 1,
      ...(kind === "apiKey" ? { apiKey: value } : { cookie: value }),
    };
    options.executor.bindCredential(input);
    return true;
  }
  rememberCredential(options);
  return true;
}
async function makePlan(options: AdminUiOptions, operationId: string, input: unknown): Promise<AdminPlanHandle> {
  const plan = await options.executor.plan(operationId, input);
  cachedPlans(options).set(plan.planId, plan);
  return plan;
}



async function applyPlan(options: AdminUiOptions, context: AdminContext, planId: string): Promise<void> {
  if (!hasInteractiveUi(context)) {
    notify(context, "administration apply requires an interactive human UI; no request was sent", "warning");
    return;
  }
  const plan = cachedPlans(options).get(planId) ?? options.executor.getPlan(planId);
  if (!plan) {
    notify(context, "plan is unavailable or expired; create a new preview; no request was sent", "warning");
    return;
  }
  const preview = plan.preview;
  notify(context, `Exact administration target and redacted change:\n${redactPreview(preview)}\nThis preview will be re-read for drift before dispatch.`, "warning");
  const typed = await askText(context, `Type APPLY to confirm plan ${planId}`);
  if (typed !== "APPLY") {
    notify(context, "administration apply denied; no request was sent", "warning");
    return;
  }
  const confirmed = await context.ui.confirm("Apply administration plan", `${redactPreview(preview)}\n\nConfirm this exact target, side effect, and irreversible consequence?`);
  if (!confirmed) {
    notify(context, "administration apply cancelled; no request was sent", "warning");
    return;
  }
  try {
    const result = await options.executor.apply(planId, { confirmed: true, confirm: true, headless: false });
    if (result.status === "applied") notify(context, `administration plan applied: ${planId}`, "info");
    else if (result.status === "operator-required") notify(context, `administration requires a separate operator action; no applied result was recorded (${planId})`, "warning");
    else if (result.status === "unknown") notify(context, `administration outcome is unknown; reconcile before retrying (${planId})`, "warning");
    else notify(context, `administration plan was not applied (${planId})`, "warning");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "request_failed";
    notify(context, `administration apply failed (${code}); no retry was attempted`, "warning");
  }
}

async function browse(options: AdminUiOptions, context: AdminContext, search: string): Promise<void> {
  const categories = listCategories().filter(category => category.toLowerCase().includes(search.toLowerCase()));
  const normalizedSearch = search.toLowerCase();
  const operations = operationRegistry.descriptors()
    .filter(descriptor => `${descriptor.operationId} ${descriptor.pathTemplate}`.toLowerCase().includes(normalizedSearch))
    .sort((left, right) => left.operationId.localeCompare(right.operationId))
    .slice(0, 40);
  const categoryText = categories.slice(0, 20).join(", ") || "none";
  const operationText = operations.map(descriptor => {
    const adapter = operationRegistry.lookup(descriptor.operationId);
    if (!adapter) return `${descriptor.operationId} [unavailable: non-invokable closed descriptor]`;
    return adapter.eligibility.status === "verified"
      ? `${descriptor.operationId} [available]`
      : `${descriptor.operationId} [unavailable: ${adapter.eligibility.reason}]`;
  }).join("\n") || "none";
  notify(context, `categories: ${categoryText}\noperations:\n${operationText}`);
  const operationId = await askText(context, "Operation ID (Esc cancels)");
  if (!operationId) return;
  const adapter: OperationAdapter | undefined = operationRegistry.lookup(operationId);
  if (!adapter) {
    notify(context, "unknown or non-invokable operation; no request was sent", "warning");
    return;
  }
  if (adapter.eligibility.status !== "verified") {
    notify(context, `operation unavailable: ${adapter.eligibility.reason}; no request was sent`, "warning");
    return;
  }
  const raw = await askText(context, `Validated JSON input for ${operationId} ({} if empty)`, adapter.descriptor.secrets.inputFields.length > 0);
  if (!raw) return;

  let input: unknown;
  try { input = JSON.parse(raw); } catch { notify(context, "input is not valid JSON; no request was sent", "warning"); return; }
  let plan: AdminPlanHandle;
  try { plan = await makePlan(options, operationId, input); } catch { notify(context, "input was rejected by the closed operation validator; no request was sent", "warning"); return; }
  notify(context, `plan ${plan.planId} created\n${redactPreview(plan.preview)}`, "info");
}
async function enableAdmin(options: AdminUiOptions, context: AdminContext): Promise<void> {
  if (!hasInteractiveUi(context)) {
    notify(context, "administration enable requires an interactive human UI; no request was sent", "warning");
    return;
  }
  let binding: AdminBinding | undefined;
  try {
    binding = await options.resolveEffectiveEndpoint?.();
  } catch {
    notify(context, "unable to resolve the active/environment administration endpoint; no request was sent", "warning");
    return;
  }
  const endpoint = binding?.endpoint ?? await askText(context, "Administration endpoint (exact active/environment endpoint)");
  if (!endpoint) {
    notify(context, "administration enable cancelled; no request was sent", "warning");
    return;
  }
  const confirmed = await context.ui.confirm("Enable OmniRoute administration", `Exact endpoint: ${endpoint}\nPersist non-secret adminEnabled for this profile?`);
  if (!confirmed) {
    notify(context, "administration enable cancelled; no request was sent", "warning");
    return;
  }
  if (!options.onEnable) {
    notify(context, "administration enable is unavailable; no request was sent", "warning");
    return;
  }
  try {
    const enabled = await options.onEnable(endpoint);
    if (!enabled) {
      notify(context, "administration enable was not persisted; no request was sent", "warning");
      return;
    }
    options.endpoint = enabled.endpoint;
    options.credentialGeneration = enabled.credentialGeneration;
    notify(context, `administration enabled for exact endpoint ${enabled.endpoint}; bind a credential before choosing an action`, "info");
  } catch {
    notify(context, "administration enable failed to persist; no request was sent", "warning");
  }
}

export function registerAdminCommand(pi: ExtensionAPI, options: AdminUiOptions): void {
  pi.registerCommand("cruxomni-admin", {
    description: "Search, preview, and human-confirm versioned OmniRoute administration operations",
    handler: async (args, ctx) => {
      const context = ctx;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "enable") {
        await enableAdmin(options, context);
        return;
      }
      try {
        await options.syncBinding?.();
      } catch {
        notify(context, "administration configuration is unavailable; no request was sent", "warning");
        return;
      }
      if (parts[0] === "apply") {
        if (!options.executor.getCredentialBinding()) await collectSessionCredential(options, context);
        const planId = parts[1] ?? await askText(context, "Plan ID to apply");
        if (planId) await applyPlan(options, context, planId);
        return;
      }
      if (parts[0] === "disable" || parts[0] === "logout") {
        if (parts[0] === "logout") options.executor.logout();
        else options.executor.disable();
        cachedPlans(options).clear();
        await options.onDisable?.();
        notify(context, "administration session cleared; no request was sent");
        return;
      }
      if (!(await collectSessionCredential(options, context))) {
        notify(context, "administration credential is required in the human-only UI; no request was sent", "warning");
        return;
      }
      await browse(options, context, parts.join(" ") || "");
    },
  });
}

export async function runAdminApply(options: AdminUiOptions, context: AdminContext, planId: string): Promise<void> {
  await applyPlan(options, context, planId);
}

export function clearAdminUiSession(options: AdminUiOptions): void {
  options.executor.logout();
  cachedPlans(options).clear();
}
