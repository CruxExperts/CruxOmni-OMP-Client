import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, setAgentDirResolverForTests, updateConfig, validateEndpoint } from "../src/config.ts";
import { OptionalCredentials } from "../src/credentials.ts";
import { createSetupWizard, setupConnection, type SetupServices } from "../src/setup.ts";

let root: string | undefined;
const savedEnvironment = { ...process.env };
afterEach(async () => {
  process.env = { ...savedEnvironment };
  setAgentDirResolverForTests(undefined);
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function isolated(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "cruxomni-setup-"));
  setAgentDirResolverForTests(() => root!);
  for (const name of Object.keys(process.env)) if (name.startsWith("OMP_OMNIROUTE_")) delete process.env[name];
}

function context(values: string[], confirmations: boolean[], notices: string[], login: (...args: any[]) => Promise<unknown>) {
  return {
    mode: "tui", hasUI: true, cwd: "/fixture/project",
    ui: {
      custom(factory: (...args: any[]) => any) {
        return new Promise(resolve => {
          const component = factory(undefined, undefined, undefined, resolve);
          const value = values.shift() ?? "";
          component.setValue(value);
          component.onSubmit(value);
        });
      },
      async confirm() { return confirmations.shift() ?? false; },
      async select() { return undefined; },
      notify(message: string) { notices.push(message); },
    },
    modelRegistry: { authStorage: { login } },
  } as never;
}

function services(): SetupServices {
  return {
    credentials: new OptionalCredentials(),
    async refresh() {}, async synchronizeAdmin() {},
    status: () => "connected; models=1; metadata=not configured",
  };
}

test("connection cancellation is byte-preserving and never invokes native login", async () => {
  await isolated();
  await updateConfig(current => ({ ...current, adminEnabled: true, invitationDismissed: true, pricingFile: "/fixture/pricing.json" }));
  const before = await readFile(getConfigPath(), "utf8");
  let logins = 0;
  const ctx = context(["https://gateway.example", "fixture-runtime-secret"], [false], [], async () => { logins++; });
  await setupConnection(ctx, services());
  expect(logins).toBe(0);
  expect(await readFile(getConfigPath(), "utf8")).toBe(before);
});

test("completed connection never serializes or announces the runtime key", async () => {
  await isolated();
  const secret = "fixture-runtime-secret";
  const endpoint = "https://gateway.example";
  const notices: string[] = [];
  let provider = "";
  const ctx = context([endpoint, secret], [true], notices, async (name: string) => {
    provider = name;
    await updateConfig(current => ({ ...current, active: { endpoint: validateEndpoint(endpoint), generation: 1 } }));
  });
  await setupConnection(ctx, services());
  expect(provider).toBe("omniroute");
  expect(await readFile(getConfigPath(), "utf8")).not.toContain(secret);
  expect(notices.join("\n")).not.toContain(secret);
  expect((await loadConfig()).active?.endpoint).toBe(endpoint);
});

test("non-TUI setup refuses without prompts, storage or mutation", async () => {
  await isolated();
  let interactions = 0;
  const notices: string[] = [];
  const wizard = createSetupWizard(services());
  await wizard({
    mode: "json", hasUI: true,
    ui: {
      notify(message: string) { notices.push(message); },
      async select() { interactions++; }, async confirm() { interactions++; return false; },
      async custom() { interactions++; },
    },
  } as never);
  expect(interactions).toBe(0);
  expect(notices.join(" ")).toContain("interactive OMP terminal");
  expect((await loadConfig()).revision).toBeUndefined();
});
