import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(import.meta.dir, "..");
const packagePrefix = "package/";
const requiredDocs = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "ASSET_LICENSE.md", "THIRD_PARTY_NOTICES.md", "LICENSE"] as const;
const allowedExact = new Set(["package.json", "VERSION", ...requiredDocs]);
const allowedPrefixes = ["src/", "contracts/", "provenance/", "scripts/", "test/fixtures/", "assets/", "docs/", ".omp-plugin/"] as const;
const supportedOmpRange = ">=18.2.3 <19";
const rangeAllowedOmpPackages = new Set([
  "@oh-my-pi/pi-ai",
  "@oh-my-pi/pi-coding-agent",
  "@oh-my-pi/pi-tui",
  "@oh-my-pi/pi-utils",
]);

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  packageManager?: unknown;
  main?: unknown;
  module?: unknown;
  exports?: unknown;
  files?: unknown;
  omp?: { extensions?: unknown };
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

interface LockPackage {
  key: string;
  name: string;
  version: string;
  resolution: string;
  integrity: string;
  dependencies: Record<string, string>;
  purl: string;
}

interface LockEvidence {
  path: "bun.lock";
  sha256: string;
  lockfileVersion: number;
  packages: LockPackage[];
}

interface Sbom {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  version: 1;
  serialNumber: string;
  metadata: { component: { type: "library"; name: string; version: string; purl: string; properties: Array<{ name: string; value: string }> } };
  components: Array<{ type: "library"; name: string; version: string; purl: string; hashes: Array<{ alg: "SHA-512" | "SHA-256"; content: string }>; properties: Array<{ name: string; value: string }> }>;
  dependencies: Array<{ ref: string; dependsOn: string[] }>;
}

interface ScanIssue {
  kind: "allowlist" | "symlink" | "private-path" | "secret" | "entrypoint" | "import" | "documentation";
  path: string;
  detail: string;
}
function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!recordValue(value)) return undefined;
  const nested = value.dependencies ?? value.requires;
  if (nested !== undefined) return stringRecord(nested);
  const entries = Object.entries(value);
  if (entries.some(([, child]) => typeof child !== "string")) return undefined;
  return Object.fromEntries(entries.map(([key, child]) => [key, child as string]));
}

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (recordValue(value)) return Object.values(value).flatMap(allStrings);
  return [];
}

function packageIdentity(identity: string, key: string): { name: string; version: string } {
  const candidate = identity.startsWith("pkg:npm/") ? identity.slice("pkg:npm/".length) : identity;
  const at = candidate.lastIndexOf("@");
  if (at <= 0 || at === candidate.length - 1) throw new Error(`bun.lock contains a package without an exact name/version identity: ${key}`);
  const name = candidate.slice(0, at).replace(/^%40/, "@");
  const version = candidate.slice(at + 1);
  if (!/^@?[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)?$/.test(name) || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`bun.lock contains a mutable or non-semver package identity: ${identity}`);
  }
  return { name, version };
}

function packagePurl(name: string, version: string): string {
  return `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;
}
function parseBunLock(text: string): unknown {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      result += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    result += character;
  }
  if (inString || escaped) throw new Error("unterminated string");
  return JSON.parse(result) as unknown;
}


async function readBunLock(manifest: PackageManifest): Promise<LockEvidence> {
  const lockPath = join(packageRoot, "bun.lock");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(lockPath));
  } catch {
    throw new Error("bun.lock is required and must be committed; generate it with the reviewed Bun toolchain after the supply-chain gate permits install");
  }
  try {
    await command("git", ["ls-files", "--error-unmatch", "--", "bun.lock"], packageRoot);
  } catch {
    throw new Error("bun.lock is required and must be committed; an untracked lockfile is not accepted");
  }
  if (bytes.byteLength === 0) throw new Error("bun.lock is required and must be committed; the committed lock is empty");
  let parsed: unknown;
  try {
    parsed = parseBunLock(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("bun.lock must be valid Bun text lockfile data with exact transitive identities and integrities");
  }
  if (!recordValue(parsed) || typeof parsed.lockfileVersion !== "number" || !Number.isInteger(parsed.lockfileVersion)) {
    throw new Error("bun.lock must declare an integer lockfileVersion");
  }
  if (!recordValue(parsed.packages)) throw new Error("bun.lock must contain the complete transitive packages table");
  const packages: LockPackage[] = [];
  for (const [key, raw] of Object.entries(parsed.packages)) {
    if (key === "" || key === ".") continue;
    if (!Array.isArray(raw)) throw new Error(`bun.lock package entry ${key} is not a Bun package tuple`);
    const strings = allStrings(raw);
    const identity = strings.find(value => value.includes("@") && !/^sha(?:256|384|512)-/i.test(value) && !/^(?:https?|git|file):/i.test(value));
    if (!identity) throw new Error(`bun.lock package entry ${key} is missing an exact package identity`);
    const { name, version } = packageIdentity(identity, key);
    const integrity = strings.find(value => /^(?:sha(?:256|384|512)-[A-Za-z0-9+/=]+|[a-f0-9]{64})$/.test(value));
    if (!integrity) throw new Error(`bun.lock package ${name}@${version} is missing an integrity`);
    if (/^(?:workspace:|catalog:|latest$|[~^*]|(?:git|github|file|https?):)/i.test(identity)) {
      throw new Error(`bun.lock package ${name}@${version} uses a mutable resolution`);
    }
    const dependencies: Record<string, string> = {};
    const optionalPeers = new Set(raw.flatMap(value => recordValue(value) && Array.isArray(value.optionalPeers) ? value.optionalPeers.filter((name): name is string => typeof name === "string") : []));
    for (const value of raw) {
      if (!recordValue(value)) continue;
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
        const entries = stringRecord(value[field]);
        if (entries) for (const [name, spec] of Object.entries(entries)) {
          if (field === "peerDependencies" && optionalPeers.has(name)) continue;
          dependencies[name] = spec;
        }
      }
    }
    packages.push({
      key,
      name,
      version,
      resolution: identity,
      integrity,
      dependencies,
      purl: packagePurl(name, version),
    });
  }
  if (packages.length === 0) throw new Error("bun.lock must contain at least one exact transitive package");
  const names = new Set(packages.map(item => item.name));
  const declaredGroups = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies];
  const declared = declaredGroups.flatMap(group => Object.keys(group ?? {}));
  for (const group of declaredGroups) {
    for (const [name, spec] of Object.entries(group ?? {})) {
      const exact = typeof spec === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec);
      const supportedHostRange = rangeAllowedOmpPackages.has(name) && spec === supportedOmpRange;
      if (!exact && !supportedHostRange) throw new Error(`manifest dependency ${name} must pin an exact semver or use the reviewed OMP compatibility range ${supportedOmpRange}`);
    }
  }
  for (const name of declared) if (!names.has(name)) throw new Error(`bun.lock is missing the declared dependency ${name}`);
  if (typeof manifest.packageManager !== "string" || !/^bun@\d+\.\d+\.\d+$/.test(manifest.packageManager)) throw new Error("manifest.packageManager must pin an exact Bun version (for example bun@1.3.14)");
  return {
    path: "bun.lock",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    lockfileVersion: parsed.lockfileVersion,
    packages,
  };
}

function isAllowed(relativePath: string): boolean {
  return allowedExact.has(relativePath) || allowedPrefixes.some(prefix => relativePath.startsWith(prefix));
}

function normalizeArchiveEntry(entry: string): string {
  const cleaned = entry.replaceAll("\\", "/").replace(/\/$/, "");
  if (!cleaned.startsWith(packagePrefix)) throw new Error(`archive entry is outside package/: ${entry}`);
  const path = cleaned.slice(packagePrefix.length);
  if (path.length === 0 || isAbsolute(path) || path.split("/").some(part => part === ".." || part === "")) throw new Error(`unsafe archive entry: ${entry}`);
  return path;
}

async function command(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(command, args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, npm_config_ignore_scripts: "true" } });
  } catch (error) {
    const failure = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
    const detail = typeof failure.stderr === "string" && failure.stderr.trim().length > 0 ? failure.stderr.trim() : String(failure.message ?? error);
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
}
function packMetadata(parsed: unknown): Record<string, unknown> {
  let value: unknown;
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) throw new Error("npm pack returned an unexpected result");
    value = parsed[0];
  } else if (parsed && typeof parsed === "object") {
    const entries = Object.entries(parsed);
    if (entries.length !== 1) throw new Error("npm pack returned an unexpected result");
    value = entries[0]![1];
  } else {
    throw new Error("npm pack returned an unexpected result");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("npm pack returned an unexpected result");
  return value as Record<string, unknown>;
}

async function packPackage(destination: string): Promise<{ archive: string; entries: string[] }> {
  const packed = await command("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], packageRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(packed.stdout);
  } catch (error) {
    throw new Error(`npm pack did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const metadata = packMetadata(parsed);
  const filename = metadata.filename;
  if (typeof filename !== "string" || filename.length === 0) throw new Error("npm pack did not report an archive filename");
  const archive = resolve(destination, filename);
  if (!archive.startsWith(`${resolve(destination)}${sep}`)) throw new Error("npm pack archive escaped its temporary directory");
  const listing = await command("tar", ["--list", "--file", archive, "--gzip", "--quoting-style=escape"], destination);
  const entries = listing.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0 && !line.endsWith("/")).map(normalizeArchiveEntry);
  if (new Set(entries).size !== entries.length) throw new Error("package archive contains duplicate entries");
  for (const entry of entries) if (!isAllowed(entry)) throw new Error(`package archive entry is not allowlisted: ${entry}`);
  return { archive, entries };
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path).split(sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed in package: ${relativePath}`);
    if (entry.isDirectory()) result.push(...await walk(root, path));
    else if (entry.isFile()) result.push(relativePath);
    else throw new Error(`unsupported package entry type: ${relativePath}`);
  }
  return result;
}

function manifestString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function entrypointPaths(manifest: PackageManifest): string[] {
  const result: string[] = [];
  for (const [label, value] of [["main", manifest.main], ["module", manifest.module]] as const) {
    if (value !== undefined) result.push(manifestString(value, `manifest.${label}`));
  }
  const extensions = manifest.omp?.extensions;
  if (Array.isArray(extensions)) for (const [index, value] of extensions.entries()) result.push(manifestString(value, `manifest.omp.extensions[${index}]`));
  else if (extensions !== undefined) throw new Error("manifest.omp.extensions must be an array");
  const exportsValue = manifest.exports;
  const visitExports = (value: unknown): void => {
    if (typeof value === "string") {
      result.push(value);
      return;
    }
    if (!value || typeof value !== "object") throw new Error("manifest.exports contains an invalid target");
    for (const nested of Object.values(value as Record<string, unknown>)) visitExports(nested);
  };
  if (exportsValue !== undefined) visitExports(exportsValue);
  return result;
}

async function resolveEntrypoint(root: string, target: string): Promise<string> {
  if (!target.startsWith("./") || target.includes("..")) throw new Error(`entrypoint must be a package-relative path: ${target}`);
  const candidate = resolve(root, target);
  if (!candidate.startsWith(`${root}${sep}`)) throw new Error(`entrypoint escaped extracted package: ${target}`);
  const candidates = [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`, `${candidate}.mjs`, `${candidate}.json`, join(candidate, "index.ts"), join(candidate, "index.js")];
  for (const path of candidates) {
    try {
      const info = await lstat(path);
      if (info.isFile()) return path;
    } catch {
      // Continue trying the explicit extension candidates.
    }
  }
  throw new Error(`entrypoint does not resolve: ${target}`);
}

async function scanImports(root: string, files: string[], issues: ScanIssue[]): Promise<void> {
  const importPattern = /(?:from\s*|import\s*\(|import\s+)(["'])([^"']+)\1/g;
  for (const relativePath of files) {
    if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(relativePath)) continue;
    const text = await readFile(join(root, relativePath), "utf8");
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[2];
      if (!specifier?.startsWith(".")) continue;
      const target = resolve(dirname(join(root, relativePath)), specifier);
      if (!target.startsWith(`${root}${sep}`)) {
        issues.push({ kind: "import", path: relativePath, detail: `relative import escapes package: ${specifier}` });
        continue;
      }
      const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}.mjs`, `${target}.json`, join(target, "index.ts"), join(target, "index.js")];
      let found = false;
      for (const candidate of candidates) {
        try {
          if ((await lstat(candidate)).isFile()) {
            found = true;
            break;
          }
        } catch {
          // Continue trying candidates.
        }
      }
      if (!found) issues.push({ kind: "import", path: relativePath, detail: `unresolved relative import: ${specifier}` });
    }
  }
}

async function scanText(root: string, files: string[], issues: ScanIssue[]): Promise<Record<string, string>> {
  interface JsonStringLiteral {
    start: number;
    end: number;
    value: string;
    fieldPath: string[];
  }

  const parseJsonStringLiterals = (text: string): JsonStringLiteral[] => {
    const literals: JsonStringLiteral[] = [];
    let cursor = 0;
    const skipWhitespace = (): void => {
      while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
    };
    const parseString = (): { start: number; end: number; value: string } => {
      const start = cursor;
      if (text[cursor] !== '"') throw new Error("expected JSON string");
      cursor += 1;
      let escaped = false;
      while (cursor < text.length) {
        const character = text[cursor] ?? "";
        cursor += 1;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (character === "\\") {
          escaped = true;
          continue;
        }
        if (character === '"') {
          const end = cursor;
          const value = JSON.parse(text.slice(start, end));
          if (typeof value !== "string") throw new Error("JSON string did not decode to a string");
          return { start, end, value };
        }
      }
      throw new Error("unterminated JSON string");
    };
    const parseValue = (fieldPath: string[]): void => {
      skipWhitespace();
      const marker = text[cursor];
      if (marker === '"') {
        const literal = parseString();
        literals.push({ ...literal, fieldPath });
        return;
      }
      if (marker === "{") {
        cursor += 1;
        skipWhitespace();
        if (text[cursor] === "}") {
          cursor += 1;
          return;
        }
        while (cursor < text.length) {
          const key = parseString();
          skipWhitespace();
          if (text[cursor] !== ":") throw new Error("expected JSON object colon");
          cursor += 1;
          parseValue([...fieldPath, key.value]);
          skipWhitespace();
          if (text[cursor] === "}") {
            cursor += 1;
            return;
          }
          if (text[cursor] !== ",") throw new Error("expected JSON object comma");
          cursor += 1;
          skipWhitespace();
        }
        throw new Error("unterminated JSON object");
      }
      if (marker === "[") {
        cursor += 1;
        skipWhitespace();
        if (text[cursor] === "]") {
          cursor += 1;
          return;
        }
        while (cursor < text.length) {
          parseValue(fieldPath);
          skipWhitespace();
          if (text[cursor] === "]") {
            cursor += 1;
            return;
          }
          if (text[cursor] !== ",") throw new Error("expected JSON array comma");
          cursor += 1;
          skipWhitespace();
        }
        throw new Error("unterminated JSON array");
      }
      const start = cursor;
      while (cursor < text.length && !/[,\]}\s]/.test(text[cursor] ?? "")) cursor += 1;
      if (cursor === start) throw new Error("expected JSON value");
    };
    try {
      parseValue([]);
      skipWhitespace();
      if (cursor !== text.length) throw new Error("trailing JSON input");
      return literals;
    } catch {
      return [];
    }
  };

  const contextWords = (value: string): string[] => value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const hasImmutableIdentifier = (value: string): boolean => contextWords(value).some(word => /^(?:sha\d*|hash|digest|blob|tree|commit)$/.test(word));
  const hasFixtureIdentifier = (value: string): boolean => contextWords(value).some(word => word === "fixture" || word === "fixtures");
  const jsonValueHasContext = (relativePath: string, fieldPath: string[]): boolean => {
    const words = fieldPath.flatMap(contextWords);
    if (words.some(word => /^(?:sha\d*|hash|digest|blob|tree|commit)$/.test(word))) return true;
    if (words.some(word => word === "url" || word === "uri" || word === "href")) return true;
    if (hasFixtureIdentifier(fieldPath.join("_"))) return true;
    const leaf = fieldPath[fieldPath.length - 1]?.toLowerCase();
    const parent = fieldPath[fieldPath.length - 2]?.toLowerCase();
    if (relativePath === "package.json" && fieldPath.length === 1 && (leaf === "name" || leaf === "version")) return true;
    if (relativePath === "package.json" && (parent === "dependencies" || parent === "devdependencies" || parent === "peerdependencies" || parent === "optionaldependencies")) return true;
    if (words.includes("package") && (words.includes("name") || words.includes("version"))) return true;
    return false;
  };
  const sourceLiteralHasContext = (text: string, start: number): boolean => {
    const prefix = text.slice(Math.max(0, start - 240), start);
    const candidates: string[] = [];
    for (const pattern of [
      /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*$/,
      /([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*:\s*$/,
      /([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*,\s*$/,
    ]) {
      const match = prefix.match(pattern);
      if (match?.[1]) candidates.push(match[1]);
    }
    const declarationMatches = [...prefix.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*[\[{]\s*$/g)];
    const nearestDeclaration = declarationMatches[declarationMatches.length - 1]?.[1];
    if (nearestDeclaration) candidates.push(nearestDeclaration);
    return candidates.some(candidate => hasImmutableIdentifier(candidate) || hasFixtureIdentifier(candidate));
  };

  const hashes: Record<string, string> = {};
  const absolutePathPattern = new RegExp(
    `(?:^|[\\s"'(<[{=:])\\/(?:${["home", "Users"].join("|")})\\/[A-Za-z0-9._~-]+(?:\\/[A-Za-z0-9._~!$&'()*+,;=@%-]+)*`,
    "m",
  );
  const privateTempPathPattern = /(?:^|[\s"'(<[{=:])\/tmp\/private(?:\/|$)/m;
  const credentialNamePattern = [
    ["api", "key"].join("[_-]?"),
    ["access", "token"].join("[_-]?"),
    ["refresh", "token"].join("[_-]?"),
    "authorization",
    "password",
    "passwd",
    "secret",
    "credential",
    ["private", "key"].join("[_-]?"),
    "token",
    "cookie",
  ].join("|");
  const credentialAssignmentPattern = new RegExp(
    `(?<![A-Za-z0-9_$])(?:[A-Za-z0-9_$]*${credentialNamePattern}[A-Za-z0-9_$]*|key)(?![A-Za-z0-9_$])\\s*(?::|=(?![=>]))\\s*(?:"([^"]*)"|'([^']*)')`,
    "gi",
  );
  const unquotedCredentialPattern = new RegExp(
    `(?<![A-Za-z0-9_$])(?:[A-Za-z0-9_$]*${credentialNamePattern}[A-Za-z0-9_$]*|key)(?![A-Za-z0-9_$])\\s*(?::|=(?![=>]))\\s*([A-Za-z0-9][A-Za-z0-9_+/=-]{7,})(?![A-Za-z0-9_$])`,
    "gi",
  );
  const bearerPattern = /\bBearer\s+([A-Za-z0-9][A-Za-z0-9._~+/=-]{7,})\b/gi;
  const literalPattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;

  const isIdentifierReference = (value: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(value);
  const isNonLiteralReference = (value: string): boolean => isIdentifierReference(value) || value.startsWith("`") || value.startsWith("$");
  const isPlaceholder = (value: string): boolean => {
    const normalized = value.trim();
    return normalized.length === 0
      || /^\$\{[^}\r\n]+\}$/.test(normalized)
      || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)
      || /^<[^>\r\n]+>$/.test(normalized)
      || /^(?:fixture|example|placeholder|redacted|dummy|fake|sample|test|your|replace|change|insert|set)(?:[-_].*)?$/i.test(normalized);
  };
  const hasHighEntropy = (value: string): boolean => {
    const normalized = value.trim();
    if (normalized.length < 20 || isPlaceholder(normalized)) return false;
    if (/\s/.test(normalized)) return false;
    if (/^\^.*\$$/.test(normalized) && /[\[\]{}()*+?]/.test(normalized)) return false;
    if (!/\d/.test(normalized) || /[/:.]/.test(normalized)) return false;
    if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(normalized)) return false;
    if (/^(?:[a-z][a-z0-9+.-]*):\/\//i.test(normalized)) return false;
    if (/^[a-f0-9]{32,}$/i.test(normalized) || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(normalized)) return false;
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(normalized)).length;
    if (classes < 2 || new Set(normalized).size < 10) return false;
    const counts = new Map<string, number>();
    for (const character of normalized) counts.set(character, (counts.get(character) ?? 0) + 1);
    const entropy = [...counts.values()].reduce((sum, count) => {
      const probability = count / normalized.length;
      return sum - probability * Math.log2(probability);
    }, 0);
    return entropy >= 3.5;
  };

  for (const relativePath of files) {
    const bytes = new Uint8Array(await readFile(join(root, relativePath)));
    hashes[relativePath] = createHash("sha256").update(bytes).digest("hex");
    if (bytes.includes(0)) continue;
    const text = new TextDecoder().decode(bytes);
    if (absolutePathPattern.test(text) || privateTempPathPattern.test(text)) issues.push({ kind: "private-path", path: relativePath, detail: "private filesystem path marker" });
    for (const match of text.matchAll(credentialAssignmentPattern)) {
      const value = match[1] ?? match[2] ?? "";
      if (!isNonLiteralReference(value) && !isPlaceholder(value)) issues.push({ kind: "secret", path: relativePath, detail: "credential-like literal" });
    }
    for (const match of text.matchAll(unquotedCredentialPattern)) {
      const value = match[1] ?? "";
      if (!isNonLiteralReference(value) && !isPlaceholder(value)) issues.push({ kind: "secret", path: relativePath, detail: "credential-like literal" });
    }
    for (const match of text.matchAll(bearerPattern)) {
      const value = match[1] ?? "";
      if (!isPlaceholder(value)) issues.push({ kind: "secret", path: relativePath, detail: "credential-like bearer literal" });
    }
    const jsonLiterals = relativePath.endsWith(".json")
      ? new Map<number, JsonStringLiteral>(parseJsonStringLiterals(text).map(literal => [literal.start, literal] as const))
      : undefined;
    for (const match of text.matchAll(literalPattern)) {
      const value = match[0].slice(1, -1);
      if (!hasHighEntropy(value)) continue;
      const jsonLiteral = jsonLiterals?.get(match.index ?? -1);
      if (jsonLiteral ? jsonValueHasContext(relativePath, jsonLiteral.fieldPath) : (!jsonLiterals && sourceLiteralHasContext(text, match.index ?? -1))) continue;
      issues.push({ kind: "secret", path: relativePath, detail: "high-entropy secret-like literal" });
    }
  }
  return hashes;
}

function documentationLinks(text: string): string[] {
  const links: string[] = [];
  const pattern = /\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
  for (const match of text.matchAll(pattern)) {
    const target = match[1];
    if (!target || target.startsWith("#") || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) continue;
    links.push(target.split("#", 1)[0]!);
  }
  return links;
}

async function verifyDocumentation(root: string, files: string[], issues: ScanIssue[]): Promise<void> {
  for (const name of requiredDocs) {
    if (!files.includes(name)) issues.push({ kind: "documentation", path: name, detail: "required package document is missing" });
  }
  for (const relativePath of files.filter(path => path.endsWith(".md"))) {
    const text = await readFile(join(root, relativePath), "utf8");
    for (const target of documentationLinks(text)) {
      const resolvedTarget = resolve(dirname(join(root, relativePath)), target);
      if (!resolvedTarget.startsWith(`${root}${sep}`)) issues.push({ kind: "documentation", path: relativePath, detail: `documentation link escapes package: ${target}` });
      else {
        try {
          if (!(await lstat(resolvedTarget)).isFile()) issues.push({ kind: "documentation", path: relativePath, detail: `documentation link does not resolve: ${target}` });
        } catch {
          issues.push({ kind: "documentation", path: relativePath, detail: `documentation link does not resolve: ${target}` });
        }
      }
    }
  }
}

async function extractPackage(archive: string, destination: string): Promise<string> {
  await command("tar", ["--extract", "--file", archive, "--directory", destination, "--no-same-owner", "--no-same-permissions"], destination);
  const extracted = join(destination, "package");
  const info = await lstat(extracted);
  if (!info.isDirectory()) throw new Error("archive did not extract a package directory");
  return extracted;
}

export function buildSbom(manifest: PackageManifest, lockfile: LockEvidence): Sbom {
  const packageName = manifestString(manifest.name, "manifest.name");
  const packageVersion = manifestString(manifest.version, "manifest.version");
  const rootPurl = packagePurl(packageName, packageVersion);
  const byKey = new Map(lockfile.packages.map(item => [item.key, item]));
  const byPurl = new Map(lockfile.packages.map(item => [item.purl, item]));
  const resolveDependency = (parent: LockPackage | undefined, name: string, spec: unknown): LockPackage => {
    if (typeof spec !== "string") throw new Error(`dependency ${name} has no lock selection`);
    const nested = parent ? byKey.get(`${parent.key}/${name}`) : undefined;
    if (nested) return nested;
    const parentPrefix = parent && parent.key.endsWith(parent.name) ? parent.key.slice(0, -parent.name.length) : "";
    const sibling = parentPrefix ? byKey.get(`${parentPrefix}${name}`) : undefined;
    if (sibling && (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec) ? sibling.version === spec : true)) return sibling;
    const root = byKey.get(name);
    if (root && (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec) ? root.version === spec : true)) return root;
    const exact = lockfile.packages.filter(item => item.name === name && item.version === spec);
    if (exact.length === 1) return exact[0]!;
    throw new Error(`bun.lock dependency edge is ambiguous or unresolved: ${parent?.key ?? "<root>"} -> ${name}@${spec}`);
  };
  const component = [...byPurl.values()].map(item => {
    const hash = item.integrity.startsWith("sha512-")
      ? { alg: "SHA-512" as const, content: Buffer.from(item.integrity.slice("sha512-".length), "base64").toString("hex") }
      : item.integrity.startsWith("sha256-")
        ? { alg: "SHA-256" as const, content: Buffer.from(item.integrity.slice("sha256-".length), "base64").toString("hex") }
        : { alg: "SHA-256" as const, content: item.integrity };
    return {
      type: "library" as const,
      name: item.name,
      version: item.version,
      purl: item.purl,
      hashes: [hash],
      properties: [
        { name: "bun:resolution", value: item.resolution },
        { name: "bun:integrity", value: item.integrity },
      ],
    };
  });
  const declaredEntries = Object.entries({
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  });
  const edgeMap = new Map<string, Set<string>>([[rootPurl, new Set(declaredEntries.map(([name, spec]) => resolveDependency(undefined, name, spec).purl))]]);
  for (const item of lockfile.packages) {
    const edges = edgeMap.get(item.purl) ?? new Set<string>();
    for (const [name, spec] of Object.entries(item.dependencies)) edges.add(resolveDependency(item, name, spec).purl);
    edgeMap.set(item.purl, edges);
  }
  const dependencies = [...edgeMap.entries()].map(([ref, edges]) => ({ ref, dependsOn: [...edges].sort() }));
  const componentRefs = new Set([rootPurl, ...component.map(item => item.purl)]);
  for (const edge of dependencies) {
    if (!componentRefs.has(edge.ref) || edge.dependsOn.some(reference => !componentRefs.has(reference))) throw new Error(`SBOM contains an unresolved component reference from ${edge.ref}`);
  }
  const uuid = `${lockfile.sha256.slice(0, 8)}-${lockfile.sha256.slice(8, 12)}-5${lockfile.sha256.slice(13, 16)}-a${lockfile.sha256.slice(17, 20)}-${lockfile.sha256.slice(20, 32)}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    serialNumber: `urn:uuid:${uuid}`,
    metadata: { component: { type: "library", name: packageName, version: packageVersion, purl: rootPurl, properties: [
      { name: "cruxomni:bun-lock-sha256", value: lockfile.sha256 },
      { name: "cruxomni:bun-lock-version", value: String(lockfile.lockfileVersion) },
    ] } },
    components: component,
    dependencies,
  };
}

export interface PackageVerificationResult {
  status: "verified";
  archiveSha256: string;
  archive: string;
  extractedRoot: string;
  entries: string[];
  fileSha256: Record<string, string>;
  lockfile: LockEvidence;
  sbom: Sbom;
}

export async function verifyPackage(options: { keepTemporary?: boolean } = {}): Promise<PackageVerificationResult> {
  const sourceManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as PackageManifest;
  const lockfile = await readBunLock(sourceManifest);
  const sbom = buildSbom(sourceManifest, lockfile);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cruxomni-package-"));
  const packRoot = join(temporaryRoot, "pack");
  const extractRoot = join(temporaryRoot, "extract");
  await mkdir(packRoot, { recursive: true });
  await mkdir(extractRoot, { recursive: true });
  try {
    const packed = await packPackage(packRoot);
    const archiveBytes = new Uint8Array(await readFile(packed.archive));
    const extractedRoot = await extractPackage(packed.archive, extractRoot);
    const files = (await walk(extractedRoot)).sort();
    const issues: ScanIssue[] = [];
    for (const relativePath of files) if (!isAllowed(relativePath)) issues.push({ kind: "allowlist", path: relativePath, detail: "file is outside package allowlist" });
    const manifest = JSON.parse(await readFile(join(extractedRoot, "package.json"), "utf8")) as PackageManifest;
    const targets = entrypointPaths(manifest);
    for (const target of targets) {
      try {
        await resolveEntrypoint(extractedRoot, target);
      } catch (error) {
        issues.push({ kind: "entrypoint", path: target, detail: error instanceof Error ? error.message : String(error) });
      }
    }
    await scanImports(extractedRoot, files, issues);
    const fileSha256 = await scanText(extractedRoot, files, issues);
    await verifyDocumentation(extractedRoot, files, issues);
    if (issues.length > 0) throw new Error(`package verification failed:\n${issues.map(issue => `${issue.kind}: ${issue.path}: ${issue.detail}`).join("\n")}`);
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") throw new Error("package manifest name/version are required");
    if (manifest.packageManager !== sourceManifest.packageManager) throw new Error("packed package manifest packageManager does not match the reviewed source manifest");
    return {
      status: "verified",
      archiveSha256: createHash("sha256").update(archiveBytes).digest("hex"),
      archive: packed.archive,
      extractedRoot,
      entries: files,
      fileSha256,
      lockfile,
      sbom,
    };
  } finally {
    if (!options.keepTemporary && process.env.VERIFY_PACKAGE_KEEP !== "1") await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  verifyPackage({ keepTemporary: process.env.VERIFY_PACKAGE_KEEP === "1" })
    .then(result => {
      const { archive: _archive, extractedRoot: _extractedRoot, ...sanitized } = result;
      process.stdout.write(`${JSON.stringify(sanitized, null, 2)}\n`);
    })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
