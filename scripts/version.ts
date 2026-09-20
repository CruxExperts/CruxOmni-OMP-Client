import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const versionPath = resolve(root, "VERSION");
const packagePath = resolve(root, "package.json");
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function current(): string {
  const value = readFileSync(versionPath, "utf8").trim();
  if (!semver.test(value)) throw new Error(`VERSION is not semantic: ${value}`);
  return value;
}

function check(expected?: string): void {
  const version = current();
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
  if (pkg.version !== version) throw new Error(`package.json ${pkg.version} does not match VERSION ${version}`);
  if (expected && expected !== version) throw new Error(`release tag ${expected} does not match VERSION ${version}`);
  process.stdout.write(`${version}\n`);
}

function plan(): void {
  const base = current();
  let range = "HEAD";
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    range = `${tag}..HEAD`;
  } catch { /* The first release plans from all commits. */ }
  const messages = execFileSync("git", ["log", "--format=%B%x00", range], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  let bump: "patch" | "minor" | "major" = "patch";
  for (const message of messages) {
    const explicit = message.match(/^Release-Type:\s*(major|minor|patch|none)\s*$/im)?.[1];
    if (explicit === "major") bump = "major";
    else if (explicit === "minor" && bump !== "major") bump = "minor";
    else if (!explicit && (/^[a-z]+!:/m.test(message) || /^BREAKING CHANGE:/m.test(message))) {
      throw new Error("breaking commits require an explicit Release-Type: major trailer");
    }
  }
  const [major = 0, minor = 0, patch = 0] = base.split(".").map(Number);
  const next = bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
  process.stdout.write(JSON.stringify({ current: base, bump, next, commits: messages.length }, null, 2) + "\n");
}

function setVersion(value: string): void {
  if (!semver.test(value)) throw new Error(`invalid semantic version: ${value}`);
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
  pkg.version = value;
  writeFileSync(versionPath, `${value}\n`);
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  check(value);
}

const [command = "check", value] = process.argv.slice(2);
if (command === "check") check(value?.replace(/^v/, ""));
else if (command === "plan") plan();
else if (command === "set" && value) setVersion(value.replace(/^v/, ""));
else throw new Error("usage: bun run scripts/version.ts check [vX.Y.Z] | plan | set X.Y.Z");
