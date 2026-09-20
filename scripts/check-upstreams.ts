import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type JsonObject = Record<string, unknown>;
type ReleaseRecord = {
  id: string;
  repository: string;
  release: JsonObject;
  sourceHashes: JsonObject[];
};

type FetchLike = typeof fetch;

const packageRoot = resolve(import.meta.dir, "..");
const provenancePath = resolve(packageRoot, "provenance/upstreams.json");
const githubApi = "https://api.github.com";
const timeoutMs = 20_000;

function record(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function hex(value: string, label: string, length: number): string {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(value)) throw new Error(`${label} must be a lowercase ${length}-character hash`);
  return value;
}

async function requestJson(url: string, fetchImpl: FetchLike = fetch): Promise<JsonObject> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "cruxexperts-cruxomni-upstream-check",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${url} returned non-JSON HTTP ${response.status}`);
    }
    if (!response.ok) {
      const detail = record(parsed, `${url} error`).message;
      throw new Error(`${url} returned HTTP ${response.status}${typeof detail === "string" ? `: ${detail}` : ""}`);
    }
    return record(parsed, url);
  } finally {
    clearTimeout(timer);
  }
}

async function requestBytes(url: string, fetchImpl: FetchLike = fetch): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/octet-stream", "user-agent": "cruxexperts-cruxomni-upstream-check" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function gitBlobSha1(bytes: Uint8Array): string {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const payload = new Uint8Array(header.byteLength + bytes.byteLength);
  payload.set(header);
  payload.set(bytes, header.byteLength);
  return createHash("sha1").update(payload).digest("hex");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function repositoryParts(repository: string): { owner: string; name: string } {
  const match = /^([^/]+)\/([^/]+)$/.exec(repository);
  if (!match) throw new Error(`invalid GitHub repository: ${repository}`);
  return { owner: match[1]!, name: match[2]! };
}

function apiUrl(repository: string, path: string): string {
  const { owner, name } = repositoryParts(repository);
  return `${githubApi}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${path}`;
}

async function resolvePeeledCommit(repository: string, tag: string, fetchImpl: FetchLike): Promise<{ tagObject: string; peeledCommit: string }> {
  let ref = await requestJson(apiUrl(repository, `/git/ref/tags/${encodeURIComponent(tag)}`), fetchImpl);
  let object = record(ref.object, "tag ref object");
  const tagObject = hex(stringValue(object.sha, "tag ref object.sha"), "tag ref object.sha", 40);
  let sha = tagObject;
  let type = stringValue(object.type, "tag ref object.type");
  for (let depth = 0; depth < 5; depth += 1) {
    if (type === "commit") return { tagObject, peeledCommit: hex(sha, "peeled commit", 40) };
    if (type !== "tag") throw new Error(`tag ${tag} resolves to unsupported Git object type ${type}`);
    const tagData = await requestJson(apiUrl(repository, `/git/tags/${sha}`), fetchImpl);
    object = record(tagData.object, "annotated tag object");
    sha = hex(stringValue(object.sha, "annotated tag object.sha"), "annotated tag object.sha", 40);
    type = stringValue(object.type, "annotated tag object.type");
  }
  throw new Error(`tag ${tag} has too many annotated tag indirections`);
}

async function selectorTag(selectorUrl: string, fetchImpl: FetchLike): Promise<{ tag: string; redirectedUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(selectorUrl, {
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "cruxexperts-cruxomni-upstream-check" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${selectorUrl} returned HTTP ${response.status}`);
    const finalUrl = response.url;
    const match = /\/releases\/tag\/([^/?#]+)(?:[?#].*)?$/.exec(new URL(finalUrl).pathname + new URL(finalUrl).search);
    if (!match) throw new Error(`${selectorUrl} did not redirect to a release tag (final URL ${finalUrl})`);
    return { tag: decodeURIComponent(match[1]!), redirectedUrl: finalUrl };
  } finally {
    clearTimeout(timer);
  }
}

async function checkSourceHash(repository: string, commit: string, source: JsonObject, fetchImpl: FetchLike): Promise<JsonObject> {
  const path = stringValue(source.path, "source hash path");
  const algorithm = stringValue(source.algorithm, `${path}.algorithm`);
  const expected = stringValue(source.hash, `${path}.hash`);
  if (path === "commit-tree" && algorithm === "git-tree-sha1") {
    const commitData = await requestJson(apiUrl(repository, `/git/commits/${commit}`), fetchImpl);
    const tree = record(commitData.tree, "commit tree");
    const observed = hex(stringValue(tree.sha, "commit tree.sha"), "commit tree.sha", 40);
    return { path, algorithm, expected, observed, matches: expected === observed };
  }
  if (algorithm !== "git-blob-sha1") throw new Error(`unsupported source hash algorithm ${algorithm} for ${path}`);
  const { owner, name } = repositoryParts(repository);
  const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const observed = gitBlobSha1(await requestBytes(rawUrl, fetchImpl));
  return { path, algorithm, expected, observed, matches: expected === observed };
}

async function sourceContract(recordValue: ReleaseRecord, observedCommit: string, fetchImpl: FetchLike): Promise<JsonObject[]> {
  const results: JsonObject[] = [];
  for (const source of recordValue.sourceHashes) results.push(await checkSourceHash(recordValue.repository, observedCommit, source, fetchImpl));
  return results;
}

function readUpstreamRecords(parsed: unknown): ReleaseRecord[] {
  const root = record(parsed, "provenance root");
  const values = arrayValue(root.upstreams, "provenance upstreams");
  return values.map((value, index) => {
    const entry = record(value, `upstreams[${index}]`);
    return {
      id: stringValue(entry.id, `upstreams[${index}].id`),
      repository: stringValue(entry.repository, `upstreams[${index}].repository`),
      release: record(entry.release, `upstreams[${index}].release`),
      sourceHashes: arrayValue(entry.source_hashes, `upstreams[${index}].source_hashes`).map((item, sourceIndex) => record(item, `upstreams[${index}].source_hashes[${sourceIndex}]`)),
    };
  });
}

function diffEntry(path: string, expected: unknown, observed: unknown): JsonObject {
  return { path, expected, observed, changed: JSON.stringify(expected) !== JSON.stringify(observed) };
}

export async function recheckUpstreams(fetchImpl: FetchLike = fetch): Promise<JsonObject> {
  const provenance = JSON.parse(await readFile(provenancePath, "utf8")) as unknown;
  const root = record(provenance, "provenance root");
  const selectorPolicy = record(root.selector_policy, "selector_policy");
  const selectorUrls = arrayValue(selectorPolicy.selector_urls, "selector_policy.selector_urls").map((value, index) => stringValue(value, `selector_urls[${index}]`));
  const records = readUpstreamRecords(provenance);
  if (records.length !== selectorUrls.length) throw new Error("selector policy and upstream record counts differ");

  const upstreamResults: JsonObject[] = [];
  let changed = false;
  for (const [index, expectedRecord] of records.entries()) {
    const expectedRelease = expectedRecord.release;
    const selectorUrl = selectorUrls[index]!;
    const selector = await selectorTag(selectorUrl, fetchImpl);
    const api = await requestJson(apiUrl(expectedRecord.repository, "/releases/latest"), fetchImpl);
    const apiTag = stringValue(api.tag_name, `${expectedRecord.id}.latest.tag_name`);
    const resolved = await resolvePeeledCommit(expectedRecord.repository, apiTag, fetchImpl);
    const expectedTag = stringValue(expectedRelease.tag, `${expectedRecord.id}.release.tag`);
    const expectedCommit = stringValue(expectedRelease.peeled_commit, `${expectedRecord.id}.release.peeled_commit`);
    const expectedVersion = stringValue(expectedRelease.version, `${expectedRecord.id}.release.version`);
    const observedVersion = apiTag.replace(/^v/, "");
    const diffs = [
      diffEntry("release.version", expectedVersion, observedVersion),
      diffEntry("release.tag", expectedTag, apiTag),
      diffEntry("selector.redirect.tag", expectedTag, selector.tag),
      diffEntry("selector.redirect.url", expectedRelease.release_url, selector.redirectedUrl.replace(/#.*$/, "")),
      diffEntry("release.release_id", expectedRelease.release_id, api.id),
      diffEntry("release.peeled_commit", expectedCommit, resolved.peeledCommit),
      diffEntry("release.annotated_tag_object", expectedRelease.annotated_tag_object ?? null, resolved.tagObject === resolved.peeledCommit ? null : resolved.tagObject),
      diffEntry("selector_and_api_agree", true, selector.tag === apiTag),
    ];
    const sourceHashes = await sourceContract(expectedRecord, resolved.peeledCommit, fetchImpl);
    for (const hash of sourceHashes) if (hash.matches !== true) diffs.push(diffEntry(`source_hash.${String(hash.path)}`, hash.expected, hash.observed));
    const recordResult = {
      id: expectedRecord.id,
      repository: expectedRecord.repository,
      selector: { url: selectorUrl, redirectedUrl: selector.redirectedUrl, tag: selector.tag },
      api: { tag: apiTag, id: api.id, releaseUrl: api.html_url ?? null },
      resolved: { tagObject: resolved.tagObject, peeledCommit: resolved.peeledCommit },
      sourceHashes,
      diffs,
    } satisfies JsonObject;
    upstreamResults.push(recordResult);
    if (diffs.some(item => item.changed === true)) changed = true;
  }

  const localPackageHashes: JsonObject[] = [];
  for (const value of arrayValue(root.package_source_hashes, "package_source_hashes")) {
    const hash = record(value, "package source hash");
    const path = stringValue(hash.path, "package source hash.path");
    if (path.startsWith("/") || path.split("/").some(part => part === ".." || part.length === 0)) throw new Error(`unsafe package source hash path: ${path}`);
    const expected = stringValue(hash.hash, `${path}.hash`);
    const bytes = new Uint8Array(await readFile(resolve(packageRoot, path)));
    const observed = sha256(bytes);
    localPackageHashes.push({ path, algorithm: hash.algorithm, expected, observed, matches: expected === observed });
    if (expected !== observed) changed = true;
  }
  const result = {
    schema_version: 1,
    checked_at: new Date().toISOString(),
    policy: "read_only_latest_selector_recheck",
    changed,
    status: changed ? "drift" : "verified",
    upstreams: upstreamResults,
    packageSourceHashes: localPackageHashes,
  } satisfies JsonObject;
  return result;
}

function printResult(result: JsonObject): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) {
  recheckUpstreams()
    .then(result => {
      printResult(result);
      if (result.status !== "verified") process.exitCode = 1;
    })
    .catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      printResult({ schema_version: 1, policy: "read_only_latest_selector_recheck", status: "error", changed: true, error: message });
      process.exitCode = 1;
    });
}
