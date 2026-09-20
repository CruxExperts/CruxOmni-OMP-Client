import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const manifest = JSON.parse(await readFile(resolve(root, ".omp-plugin/marketplace.json"), "utf8")) as Record<string, any>;
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as Record<string, any>;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`marketplace manifest invalid: ${message}`);
}

requireValue(manifest.schemaVersion === 1, "schemaVersion must be 1");
requireValue(manifest.id === "cruxomni-omp-client", "stable id mismatch");
requireValue(manifest.name === pkg.omp?.name, "display name differs from package omp.name");
requireValue(manifest.package === pkg.name && manifest.version === pkg.version, "package identity/version mismatch");
requireValue(manifest.entrypoint === pkg.omp?.extensions?.[0], "entrypoint differs from OMP extension");
requireValue(manifest.compatibility?.host === pkg.omp?.compatibility?.host, "host range mismatch");
requireValue(JSON.stringify(manifest.compatibility?.tested) === JSON.stringify(pkg.omp?.compatibility?.tested), "tested host matrix mismatch");
requireValue(manifest.license === pkg.license && manifest.publisher === "Crux Experts LLC", "license or publisher mismatch");
requireValue(manifest.publication === "prepared-not-published", "publication status must remain preparation-only");
for (const field of ["url", "homepage", "issues"]) requireValue(/^https:\/\/github\.com\/CruxExperts\/CruxOmni-OMP-Client(?:$|[\/#])/.test(manifest.repository?.[field] ?? ""), `${field} is not the public project URL`);
process.stdout.write(`${JSON.stringify({ status: "verified", id: manifest.id, version: manifest.version, publication: manifest.publication })}\n`);
