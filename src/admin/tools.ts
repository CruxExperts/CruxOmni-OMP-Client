import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { operationRegistry, type OperationAdapter } from "./registry.ts";
import type { AdminExecutor } from "./executor.ts";
import { clearAdminUiSession, rememberAdminPlan, type AdminUiOptions, runAdminApply } from "./ui.ts";

const DEFAULT_PROFILE = "omniroute";

type ToolContext = ExtensionContext;

export interface AdminToolsOptions {
  readonly executor: AdminExecutor;
  readonly ui: AdminUiOptions;
  readonly profileId?: string;
  endpoint?: string;
  credentialGeneration?: number;
  readonly syncBinding?: () => Promise<void>;
}

function safeText(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, (_key, child) => typeof child === "string" ? child.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2_000) : child) ?? "[unavailable]";
    return serialized.slice(0, 12_000);
  } catch {
    return "[unavailable]";
  }
}

function errorOutput(error: unknown, operationId?: string): { code: string; status?: number; operationId?: string; correlationId: string } {
  if (error !== null && typeof error === "object") {
    const code = "code" in error && typeof error.code === "string" ? error.code : "request_failed";
    const correlationId = "correlationId" in error && typeof error.correlationId === "string"
      ? error.correlationId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "redacted"
      : "redacted";
    const output: { code: string; status?: number; operationId?: string; correlationId: string } = { code, correlationId };
    if ("status" in error && typeof error.status === "number") output.status = error.status;
    if ("operationId" in error && typeof error.operationId === "string") output.operationId = error.operationId;
    else if (operationId) output.operationId = operationId;
    return output;
  }
  return { code: "request_failed", ...(operationId ? { operationId } : {}), correlationId: "redacted" };
}

function operationIds(): [string, ...string[]] {
  const ids = operationRegistry.descriptors().map(item => item.operationId);
  const first = ids[0];
  return first === undefined ? ["__no_operations__"] : [first, ...ids.slice(1)];
}

function parseInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("input must be an object");
  return input;
}

function credentialFromEnvironment(options: AdminToolsOptions): void {
  const endpoint = options.endpoint ?? options.ui.endpoint;
  if (!endpoint) return;
  const apiKey = process.env.OMP_OMNIROUTE_ADMIN_API_KEY?.trim();
  const cookie = process.env.OMP_OMNIROUTE_ADMIN_COOKIE?.trim();
  if (!apiKey && !cookie) return;
  options.executor.bindCredential({
    profileId: options.profileId ?? options.ui.profileId ?? DEFAULT_PROFILE,
    endpoint,
    credentialGeneration: options.credentialGeneration ?? options.ui.credentialGeneration ?? 1,
    ...(apiKey ? { apiKey } : {}),
    ...(cookie ? { cookie } : {}),
  });
}

type ToolOutput = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

function content(text: string): ToolOutput {
  return { content: [{ type: "text", text }], details: {} };
}

async function executeRead(options: AdminToolsOptions, operationId: string, input: unknown, signal?: AbortSignal): Promise<ToolOutput> {
  const adapter = operationRegistry.lookup(operationId);
  if (!adapter) {
    const descriptor = operationRegistry.getOperation(operationId);
    return content(safeText({ code: descriptor ? "operation-unavailable" : "unknown-operation", operationId, correlationId: "redacted", ...(descriptor ? { reason: descriptor.coverage.reason ?? "non-invokable closed descriptor" } : {}) }));
  }
  if (adapter.eligibility.status !== "verified") {
    return content(safeText({ code: "operation-unavailable", operationId, correlationId: "redacted", reason: adapter.eligibility.reason }));
  }
  if (adapter.risk !== "read" || adapter.descriptor.sideEffect !== "read" || adapter.descriptor.confirmation.required || adapter.descriptor.secrets.outputFields.length > 0) {
    return content(safeText({ code: "confirmation-required", operationId, correlationId: "redacted", message: "gated reads and mutations require the human plan/apply workflow" }));
  }
  try {
    await options.syncBinding?.();
    credentialFromEnvironment(options);
    const result = await options.executor.read(operationId, parseInput(input), {
      confirmed: true,
      headless: false,
      ...(options.endpoint ?? options.ui.endpoint ? { endpoint: options.endpoint ?? options.ui.endpoint } : {}),
      ...(options.profileId ?? options.ui.profileId ? { profileId: options.profileId ?? options.ui.profileId } : {}),
      ...(signal === undefined ? {} : { signal }),
    });
    return content(safeText({ operationId: result.operationId, output: result.output, correlationId: result.correlationId }));
  } catch (error) {
    return content(safeText(errorOutput(error, operationId)));
  }
}
async function executePlan(options: AdminToolsOptions, operationId: string, input: unknown, signal?: AbortSignal): Promise<ToolOutput> {
  const adapter = operationRegistry.lookup(operationId);
  if (!adapter) {
    const descriptor = operationRegistry.getOperation(operationId);
    return content(safeText({ code: descriptor ? "operation-unavailable" : "unknown-operation", operationId, correlationId: "redacted", ...(descriptor ? { reason: descriptor.coverage.reason ?? "non-invokable closed descriptor" } : {}) }));
  }
  if (adapter.eligibility.status !== "verified") {
    return content(safeText({ code: "operation-unavailable", operationId, correlationId: "redacted", reason: adapter.eligibility.reason }));
  }
  if (adapter.descriptor.secrets.inputFields.length > 0) {
    return content(safeText({ code: "confirmation-required", operationId, correlationId: "redacted", message: "secret-bearing inputs are human-only and must be entered in /cruxomni-admin" }));
  }
  try {
    await options.syncBinding?.();
    credentialFromEnvironment(options);
    const validated = adapter.validate(parseInput(input));
    const plan = await options.executor.plan(operationId, validated, {
      ...(options.endpoint ?? options.ui.endpoint ? { endpoint: options.endpoint ?? options.ui.endpoint } : {}),
      ...(options.profileId ?? options.ui.profileId ? { profileId: options.profileId ?? options.ui.profileId } : {}),
      ...(signal === undefined ? {} : { signal }),
    });
    rememberAdminPlan(options.ui, plan);
    return content(safeText({
      planId: plan.planId,
      operationId: plan.operationId,
      risk: plan.risk,
      target: { profileId: plan.profileId, endpoint: plan.endpoint },
      expiresAt: plan.expiresAt,
      preview: plan.preview,
      next: "/cruxomni-admin apply",
    }));
  } catch (error) {
    return content(safeText(errorOutput(error, operationId)));
  }
}
export function registerAdminTools(pi: ExtensionAPI, options: AdminToolsOptions): void {
  const z = pi.zod;
  const ids = operationIds();
  const parameters = z.object({ operationId: z.enum(ids), input: z.record(z.string(), z.unknown()).optional() }).strict();
  pi.registerTool({
    name: "omniroute_admin_read",
    label: "OmniRoute Admin Read",
    description: "Read one closed, versioned OmniRoute operation through an allowlisted projection; sensitive reads require a human gate.",
    parameters,
    strict: true,
    approval: "read",
    execute: async (_toolCallId, params, signal) => executeRead(options, params.operationId, params.input ?? {}, signal),
  });
  pi.registerTool({
    name: "omniroute_admin_plan",
    label: "OmniRoute Admin Plan",
    description: "Validate and preview one closed, versioned OmniRoute operation; this tool never dispatches a mutation.",
    parameters,
    strict: true,
    approval: "read",
    execute: async (_toolCallId, params, signal) => executePlan(options, params.operationId, params.input ?? {}, signal),
  });
}

export function clearAdminToolsSession(options: AdminToolsOptions): void {
  clearAdminUiSession(options.ui);
  options.executor.logout();
}

export { runAdminApply };
