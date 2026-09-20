import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OptionalCredentials, type CredentialStore, type StoredCredential } from "../src/credentials.ts";
import { getConfigPath, loadConfig, setAgentDirResolverForTests, updateConfig } from "../src/config.ts";
import register from "../src/index.ts";

let directory: string | undefined;
afterEach(async () => { setAgentDirResolverForTests(undefined); if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });
async function isolated() {
  directory = await mkdtemp(join(tmpdir(), "cruxomni-credentials-"));
  setAgentDirResolverForTests(() => directory!);
}
function storage() {
  let id = 0;
  const rows: StoredCredential[] = [];
  const store: CredentialStore = {
    async set(provider, credential) { rows.push({ id: ++id, provider, credential }); },
    listStoredCredentials(provider) { return rows.filter(row => !provider || row.provider === provider); },
    async removeCredential(provider, id) { const index = rows.findIndex(row => row.provider === provider && row.id === id); if (index < 0) return false; rows.splice(index, 1); return true; },
  };
  return { rows, store };
}
const binding = { endpoint: "https://gateway.example", generation: 1 };
const key = { kind: "apiKey" as const, value: "fixture-optional-secret" };

test("session-only secrets vanish on restart and never enter profile files", async () => {
  await isolated(); const { store, rows } = storage(); const credentials = new OptionalCredentials();
  await credentials.save("metadata", key, binding, false, store);
  expect(await credentials.resolve("metadata", binding, store)).toEqual(key);
  expect(await new OptionalCredentials().resolve("metadata", binding, store)).toBeUndefined();
  expect(rows).toHaveLength(0);
  expect(JSON.stringify(await loadConfig())).not.toContain(key.value);
});

test("remembered credentials survive restart but reject endpoint or generation drift", async () => {
  await isolated(); const { store } = storage();
  await new OptionalCredentials().save("metadata", key, binding, true, store);
  expect(await new OptionalCredentials().resolve("metadata", binding, store)).toEqual(key);
  expect(await new OptionalCredentials().resolve("metadata", { ...binding, generation: 2 }, store)).toBeUndefined();
  expect(await new OptionalCredentials().resolve("metadata", { ...binding, endpoint: "https://other.example" }, store)).toBeUndefined();
  expect(await readFile(getConfigPath(), "utf8")).not.toContain(key.value);
});

test("forget removes only the selected owned record", async () => {
  await isolated(); const { store, rows } = storage(); const credentials = new OptionalCredentials();
  await store.set("unrelated", { type: "api_key", key: "fixture-unrelated" });
  await credentials.save("admin", key, binding, true, store);
  await credentials.forget("admin", store);
  expect(rows.map(row => row.provider)).toEqual(["unrelated"]);
  expect(await credentials.resolve("admin", binding, store)).toBeUndefined();
});

test("failed remembered persistence never silently downgrades to a session credential", async () => {
  await isolated(); const { store } = storage(); store.set = async () => { throw new Error("broker unavailable"); };
  const credentials = new OptionalCredentials();
  await expect(credentials.save("admin", key, binding, true, store)).rejects.toThrow("not activated");
  expect(await credentials.resolve("admin", binding, store)).toBeUndefined();
});

test("configuration conflict after secret persistence leaves no usable credential", async () => {
  await isolated(); const { store, rows } = storage(); const set = store.set;
  store.set = async (provider, credential) => { await set(provider, credential); await updateConfig(config => ({ ...config, invitationDismissed: true })); };
  const credentials = new OptionalCredentials();
  await expect(credentials.save("metadata", key, binding, true, store)).rejects.toThrow("not activated");
  expect(rows).toHaveLength(0);
  expect((await loadConfig()).optionalCredentials?.metadata?.state).toBe("pending");
  expect(await credentials.resolve("metadata", binding, store)).toBeUndefined();
  await credentials.forget("metadata", store);
  expect((await loadConfig()).optionalCredentials?.metadata).toBeUndefined();
});

test("an unreleased older config version is unsupported and remains untouched", async () => {
  await isolated(); await updateConfig(config => config);
  const original = (await readFile(getConfigPath(), "utf8")).replace('"version": 2', '"version": 1');
  await writeFile(getConfigPath(), original);
  await expect(loadConfig()).rejects.toMatchObject({ code: "corrupt-config" });
  expect(await readFile(getConfigPath(), "utf8")).toBe(original);
});

test("corrupt, unsupported and insecure configuration registers diagnostics only", async () => {
  await isolated(); await updateConfig(config => config);
  const baseline = await readFile(getConfigPath(), "utf8");
  for (const candidate of ["{invalid", baseline.replace('"version": 2', '"version": 99'), baseline]) {
    await writeFile(getConfigPath(), candidate); await chmod(getConfigPath(), candidate === baseline ? 0o644 : 0o600);
    let providers = 0; const commands: string[] = [];
    await register({ registerCommand(name: string) { commands.push(name); }, registerProvider() { providers++; } } as never);
    expect(providers).toBe(0); expect(commands).toContain("cruxomni");
    expect(await readFile(getConfigPath(), "utf8")).toBe(candidate);
  }
});

test("an interrupted transaction lock blocks reads and provider registration", async () => {
  await isolated();
  await updateConfig(config => ({ ...config, invitationDismissed: true }));
  const configDirectory = join(directory!, "omniroute");
  await writeFile(join(configDirectory, ".config.lock"), "interrupted\n", { mode: 0o600 });
  await expect(loadConfig()).rejects.toMatchObject({ code: "config-conflict" });
  let providers = 0;
  const commands: string[] = [];
  await register({ registerCommand(name: string) { commands.push(name); }, registerProvider() { providers++; } } as never,
    );
  expect(providers).toBe(0);
  expect(commands).toContain("cruxomni");
});

test("explicit absent-file expectation rejects a concurrent first writer", async () => {
  await isolated();
  const stale = await loadConfig();
  expect(stale.revision).toBeUndefined();
  await updateConfig(current => ({ ...current, invitationDismissed: true }), { expectedRevision: null });
  await expect(updateConfig(current => ({ ...current, adminEnabled: true }), { expectedRevision: null }))
    .rejects.toMatchObject({ code: "config-conflict" });
  const current = await loadConfig();
  expect(current.invitationDismissed).toBe(true);
  expect(current.adminEnabled).toBe(false);
});
