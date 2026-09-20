import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { verifyPackage } from "./verify-package.ts";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dir, "..");
const out = resolve(process.env.CRUXOMNI_RELEASE_DIR ?? join(root, "release"));
const sourcePrefixes = [".github/", ".omp-plugin/", "assets/", "contracts/", "docs/", "provenance/", "scripts/", "src/", "test/"];
const sourceFiles = [".gitignore", "ASSET_LICENSE.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE", "README.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "VERSION", "bun.lock", "package.json", "tsconfig.json"];
const epoch = new Date("1980-01-01T00:00:00Z");

async function command(name: string, args: string[], cwd = root): Promise<void> {
  await execFileAsync(name, args, { cwd, env: { ...process.env, TZ: "UTC" }, maxBuffer: 16 * 1024 * 1024 });
}
async function commandOutput(name: string, args: string[], cwd = root): Promise<string> {
  return (await execFileAsync(name, args, { cwd, env: process.env, maxBuffer: 16 * 1024 * 1024 })).stdout;
}
async function sha(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function touchTree(path: string): Promise<void> {
  const info = await stat(path);
  if (info.isDirectory()) for (const item of await readdir(path)) await touchTree(join(path, item));
  await utimes(path, epoch, epoch);
}
function included(path: string): boolean { return sourceFiles.includes(path) || sourcePrefixes.some(prefix => path.startsWith(prefix)); }
async function reviewedFiles(): Promise<string[]> {
  const gitRoot = (await commandOutput("git", ["rev-parse", "--show-toplevel"])).trim();
  const packagePrefix = relative(gitRoot, root).replaceAll("\\", "/");
  const listed = (await commandOutput("git", ["ls-files", "--cached", "--", root], gitRoot)).split(/\r?\n/).filter(Boolean);
  const paths = listed.map(path => packagePrefix ? path.slice(packagePrefix.length + 1) : path).filter(included).sort();
  const untracked = (await commandOutput("git", ["ls-files", "--others", "--exclude-standard", "--", root], gitRoot)).split(/\r?\n/).filter(Boolean)
    .map(path => packagePrefix ? path.slice(packagePrefix.length + 1) : path).filter(included);
  if (untracked.length) throw new Error(`release inputs must be reviewed in the Git index: ${untracked.join(", ")}`);
  const unstaged = (await commandOutput("git", ["diff", "--name-only", "--", root], gitRoot)).split(/\r?\n/).filter(Boolean)
    .map(path => packagePrefix ? path.slice(packagePrefix.length + 1) : path).filter(included);
  if (unstaged.length) throw new Error(`release inputs differ from their reviewed Git-index bytes: ${unstaged.join(", ")}`);
  for (const required of sourceFiles) if (!paths.includes(required)) throw new Error(`release source is not tracked: ${required}`);
  return paths;
}
async function copyReviewed(paths: string[], destination: string): Promise<void> {
  for (const path of paths) {
    const source = join(root, path);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`release input must be a regular non-symlink file: ${path}`);
    const bytes = await readFile(source);
    if (!bytes.includes(0)) {
      const text = bytes.toString("utf8");
      if (/\/(?:home|Users)\/[^\s"']+/.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(text)) throw new Error(`public-content scan rejected ${path}`);
    }
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await cp(source, join(destination, path), { dereference: false });
  }
}

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const sourceRevision = (await commandOutput("git", ["rev-parse", "HEAD"])).trim();
const temporary = await mkdtemp(join(tmpdir(), "cruxomni-export-"));
const stage = join(temporary, `CruxOmni-OMP-Client-${pkg.version}`);
await mkdir(stage, { recursive: true });
await mkdir(out, { recursive: true });
try {
  const reviewed = await reviewedFiles();
  await copyReviewed(reviewed, stage);
  await touchTree(stage);
  const sourceName = `CruxOmni-OMP-Client-v${pkg.version}-source.tar.gz`;
  await command("tar", ["--sort=name", "--mtime=1980-01-01 UTC", "--owner=0", "--group=0", "--numeric-owner", "-czf", join(out, sourceName), basename(stage)], temporary);

  const packageEvidence = await verifyPackage({ keepTemporary: true });
  const npmName = `cruxexperts-cruxomni-omp-client-${pkg.version}.tgz`;
  await cp(packageEvidence.archive, join(out, npmName));
  const sbomName = `CruxOmni-OMP-Client-v${pkg.version}.cdx.json`;
  await writeFile(join(out, sbomName), `${JSON.stringify(packageEvidence.sbom, null, 2)}\n`);

  const graphicsStage = join(temporary, `CruxOmni-OMP-Client-v${pkg.version}-graphics`);
  await mkdir(graphicsStage);
  const graphicsFiles = reviewed.filter(path => path.startsWith("assets/") || path === "ASSET_LICENSE.md" || path === "THIRD_PARTY_NOTICES.md");
  await copyReviewed(graphicsFiles, graphicsStage);
  await touchTree(graphicsStage);
  const graphicsName = `CruxOmni-OMP-Client-v${pkg.version}-graphics.zip`;
  await command("zip", ["-X", "-q", "-r", join(out, graphicsName), basename(graphicsStage)], temporary);

  const names = [sourceName, npmName, graphicsName, sbomName];
  const sums = await Promise.all(names.map(async name => `${await sha(join(out, name))}  ${name}`));
  await writeFile(join(out, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
  const manifest = { schemaVersion: 1, package: "@cruxexperts/cruxomni-omp-client", version: pkg.version, sourceRevision, publication: "github-release", artifacts: await Promise.all(names.map(async name => ({ name, sha256: await sha(join(out, name)) }))), lockfileSha256: packageEvidence.lockfile.sha256 };
  await writeFile(join(out, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: "prepared", directory: out, artifacts: names }, null, 2)}\n`);
  await rm(resolve(packageEvidence.extractedRoot, "..", ".."), { recursive: true, force: true });
} finally { await rm(temporary, { recursive: true, force: true }); }
