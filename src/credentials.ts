import { randomUUID } from "node:crypto";
import { loadConfig, updateConfig, type CredentialDomain, type CredentialReference } from "./config.ts";

export interface StoredCredential {
  id: number;
  provider: string;
  credential: unknown;
}
export interface CredentialStore {
  set(provider: string, credential: { type: "api_key"; key: string }): Promise<void>;
  listStoredCredentials(provider?: string): StoredCredential[];
  removeCredential(provider: string, id: number): Promise<boolean>;
}
export interface CredentialBinding { endpoint: string; generation: number }
export interface OptionalCredential { value: string; kind: "apiKey" | "cookie" }

function rawKey(credential: unknown): string | undefined {
  if (!credential || typeof credential !== "object" || !("type" in credential) || credential.type !== "api_key" || !("key" in credential)) return undefined;
  return typeof credential.key === "string" && credential.key.length > 0 ? credential.key : undefined;
}
function matches(ref: CredentialBinding, binding: CredentialBinding): boolean {
  return ref.endpoint === binding.endpoint && ref.generation === binding.generation;
}

/** One instance per loaded extension. Optional secrets never enter configuration. */
export class OptionalCredentials {
  readonly #session = new Map<CredentialDomain, OptionalCredential & CredentialBinding>();
  #busy = false;

  clear(): void { this.#session.clear(); }

  async resolve(domain: CredentialDomain, binding: CredentialBinding, store: CredentialStore): Promise<OptionalCredential | undefined> {
    const config = await loadConfig();
    if (config.pending) return undefined;
    const session = this.#session.get(domain);
    if (session) return matches(session, binding) ? { value: session.value, kind: session.kind } : undefined;
    const ref = config.optionalCredentials?.[domain];
    if (!ref || ref.state !== "ready" || !matches(ref, binding)) return undefined;
    const row = store.listStoredCredentials(ref.providerKey).find(row => row.provider === ref.providerKey && row.id === ref.rowId);
    const value = rawKey(row?.credential);
    return value ? { value, kind: ref.kind } : undefined;
  }

  async save(domain: CredentialDomain, credential: OptionalCredential, binding: CredentialBinding, remember: boolean, store: CredentialStore): Promise<void> {
    if (this.#busy) throw new Error("credential operation already in progress");
    this.#busy = true;
    try {
      if (!credential.value.trim() || (domain === "metadata" && credential.kind !== "apiKey")) throw new Error("invalid optional credential");
      const config = await loadConfig();
      if (config.pending) throw new Error("finish runtime setup before optional credentials");
      if (config.optionalCredentials?.[domain]) throw new Error("forget the existing credential before replacing it");
      if (!remember) { this.#session.set(domain, { ...credential, ...binding }); return; }
      const ref: CredentialReference = { domain, ...binding, kind: credential.kind, state: "pending", providerKey: `cruxomni-${domain}-${randomUUID()}` };
      const staged = await updateConfig(current => ({ ...current, optionalCredentials: { ...current.optionalCredentials, [domain]: ref } }), { expectedRevision: config.revision ?? null });
      let row: StoredCredential | undefined;
      try {
        await store.set(ref.providerKey, { type: "api_key", key: credential.value });
        const rows = store.listStoredCredentials(ref.providerKey).filter(item => item.provider === ref.providerKey);
        if (rows.length !== 1 || rawKey(rows[0]!.credential) !== credential.value) throw new Error("credential readback failed");
        row = rows[0]!;
        await updateConfig(current => ({ ...current, optionalCredentials: { ...current.optionalCredentials, [domain]: { ...ref, rowId: row!.id, state: "ready" } } }), { expectedRevision: staged.revision ?? null });
        this.#session.delete(domain);
      } catch {
        // Reconcile an uncertain persistence result by exact newly owned identity.
        // Retain the pending marker if storage or config cleanup cannot be proved.
        try {
          const owned = store.listStoredCredentials(ref.providerKey).filter(item => item.provider === ref.providerKey);
          for (const item of owned) {
            if (!(await store.removeCredential(ref.providerKey, item.id))) throw new Error("credential cleanup incomplete");
          }
          if (store.listStoredCredentials(ref.providerKey).length !== 0) throw new Error("credential cleanup uncertain");
          await updateConfig(current => {
            if (current.optionalCredentials?.[domain]?.providerKey !== ref.providerKey) throw new Error("credential ownership changed");
            const refs = { ...current.optionalCredentials }; delete refs[domain];
            return { ...current, optionalCredentials: refs };
          }, { expectedRevision: staged.revision ?? null });
        } catch { /* Pending reference is the recovery record, never usable as a key. */ }
        throw new Error("remembered credential was not activated; inspect setup recovery state");
      }
    } finally { this.#busy = false; }
  }

  async forget(domain: CredentialDomain, store: CredentialStore): Promise<void> {
    if (this.#busy) throw new Error("credential operation already in progress");
    this.#busy = true;
    this.#session.delete(domain);
    try {
      const config = await loadConfig();
      const ref = config.optionalCredentials?.[domain];
      if (!ref) return;
      const revoked = await updateConfig(current => ({ ...current, optionalCredentials: { ...current.optionalCredentials, [domain]: { ...ref, state: "revoked" } } }), { expectedRevision: config.revision ?? null });
      const rows = store.listStoredCredentials(ref.providerKey).filter(row => row.provider === ref.providerKey && (ref.rowId === undefined || row.id === ref.rowId));
      for (const row of rows) if (!(await store.removeCredential(ref.providerKey, row.id))) throw new Error("credential removal incomplete");
      if (store.listStoredCredentials(ref.providerKey).some(row => ref.rowId === undefined || row.id === ref.rowId)) throw new Error("credential removal uncertain");
      await updateConfig(current => {
        const refs = { ...current.optionalCredentials }; delete refs[domain];
        return { ...current, optionalCredentials: refs };
      }, { expectedRevision: revoked.revision ?? null });
    } finally { this.#busy = false; }
  }
}
