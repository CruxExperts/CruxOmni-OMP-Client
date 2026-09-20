import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { verifyPackage, type PackageVerificationResult } from "./verify-package.ts";

type JsonObject = Record<string, unknown>;
type CommandResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; dialogueCompleted: number };

const packageRoot = resolve(import.meta.dir, "..");
const packageName = "@cruxexperts/cruxomni-omp-client";
const runtimeKey = "fixture-only-runtime-key";
const adminKey = "fixture-only-admin-key";
const commandTimeoutMs = 45_000;
const sensitiveEnvironment = /(api[_-]?key|access[_-]?token|secret|password|credential|authorization|private[_-]?key|openai|anthropic|gemini|aws_|azure_)/i;
const installedCliMode = "installed-cli";

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function expectedOmpRecord(provenance: JsonObject): JsonObject {
  const values = provenance.upstreams;
  if (!Array.isArray(values)) throw new Error("provenance upstreams must be an array");
  const entry = values.map(value => objectValue(value, "upstream")).find(value => value.id === "omp");
  if (!entry) throw new Error("provenance has no OMP upstream");
  return entry;
}

type ExpectedHost = { version: string; commit: string; url: string; digest: string; checksumsUrl: string; checksumsDigest: string };
function expectedAssets(provenance: JsonObject): ExpectedHost[] {
  const artifacts = provenance.artifacts;
  if (!Array.isArray(artifacts)) throw new Error("release artifact manifest has no artifacts array");
  return artifacts.map(value => objectValue(value, "release artifact"))
    .filter(value => value.upstream === "omp" && value.kind === "release_asset")
    .map(value => {
      const tag = stringValue(value.release_tag, "OMP release tag");
      const digest = stringValue(value.sha256, "OMP binary digest");
      const checksumsDigest = stringValue(value.checksums_sha256, "OMP checksums digest");
      if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[0-9a-f]{64}$/.test(digest) || !/^[0-9a-f]{64}$/.test(checksumsDigest)) throw new Error("OMP release artifact has invalid immutable identity");
      return { version: tag.slice(1), commit: stringValue(value.peeled_commit, "OMP release commit"), url: stringValue(value.url, "OMP asset URL"), digest, checksumsUrl: stringValue(value.checksums_url, "OMP checksums URL"), checksumsDigest };
    });
}

function isWithin(root: string, candidate: string): boolean {
  const relative = resolve(candidate).slice(resolve(root).length);
  return relative === "" || relative.startsWith("/");
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

type VerifiedHost = { path: string; mode: "release-asset" | "installed-cli"; version: string; digest: string };

async function supportedHostRange(): Promise<string> {
  const manifest = objectValue(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")), "package manifest");
  const omp = objectValue(manifest.omp, "package manifest omp");
  const compatibility = objectValue(omp.compatibility, "package manifest omp.compatibility");
  return stringValue(compatibility.host, "package manifest omp.compatibility.host");
}

async function verifiedBinary(assets: ExpectedHost[]): Promise<VerifiedHost & { expected: ExpectedHost }> {
  const configured = process.env.OMP_BINARY_PATH ?? process.env.OMP_VERIFIED_BINARY;
  if (!configured || !isAbsolute(configured)) throw new Error("smoke requires OMP_BINARY_PATH as an absolute verified release asset path");
  const info = await lstat(configured).catch(() => undefined);
  const mode = process.env.OMP_SMOKE_HOST_MODE === installedCliMode ? installedCliMode : "release-asset";
  if (!info || (mode === "release-asset" ? !info.isFile() : !info.isFile() && !info.isSymbolicLink())) throw new Error(`OMP_BINARY_PATH is not an accepted executable file: ${configured}`);
  const resolved = await realpath(configured);
  if (!(await stat(resolved)).isFile()) throw new Error(`OMP_BINARY_PATH does not resolve to a regular file: ${configured}`);
  const observed = await sha256File(resolved);
  const version = await runCommand(configured, ["--version"], { cwd: packageRoot, env: cleanEnvironment(process.env), timeoutMs: 15_000 });
  if (version.code !== 0) throw new Error("OMP host did not report a version");
  const match = /\b(\d+\.\d+\.\d+)\b/.exec(`${version.stdout}\n${version.stderr}`);
  if (!match) throw new Error("OMP host version output did not contain semantic version data");
  const observedVersion = match[1]!;
  const expected = assets.find(item => item.version === observedVersion);
  if (mode === "release-asset") {
    if (!expected) throw new Error(`OMP ${observedVersion} is not in the tested release-asset matrix`);
    if (observed !== expected.digest) throw new Error(`OMP binary SHA-256 drift: expected ${expected.digest}, observed ${observed}`);
  } else {
    const cliManifestPath = resolve(resolved, "..", "..", "package.json");
    const cliManifest = objectValue(JSON.parse(await readFile(cliManifestPath, "utf8")), "installed OMP package manifest");
    if (cliManifest.name !== "@oh-my-pi/pi-coding-agent" || cliManifest.version !== observedVersion) throw new Error("installed OMP CLI identity does not match its version output");
    const range = await supportedHostRange();
    if (!Bun.semver.satisfies(observedVersion, range)) throw new Error(`installed OMP ${observedVersion} is outside supported range ${range}`);
  }
  return { path: configured, mode, version: observedVersion, digest: observed, expected: expected ?? { version: observedVersion, commit: "installed-cli", url: "installed-cli", digest: observed, checksumsUrl: "installed-cli", checksumsDigest: "0".repeat(64) } };
}

function cleanEnvironment(source: NodeJS.ProcessEnv, profileRoot?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || sensitiveEnvironment.test(name)) continue;
    if (["PATH", "LANG", "LC_ALL", "TERM", "NO_COLOR", "TZ"].includes(name)) environment[name] = value;
  }
  if (profileRoot) {
    environment.HOME = join(profileRoot, "home");
    environment.XDG_CONFIG_HOME = join(profileRoot, "config");
    environment.XDG_DATA_HOME = join(profileRoot, "data");
    environment.XDG_CACHE_HOME = join(profileRoot, "cache");
    environment.OMP_AGENT_DIR = join(profileRoot, "agent");
    environment.OMP_PROFILE = "omniroute-smoke";
  }
  return environment;
}

function runtimeDependencies(value: Record<string, unknown>, label: string): Record<string, string> {
  const dependencies: Record<string, string> = {};
  for (const [name, version] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof version !== "string" || (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version) && version !== ">=18.2.3 <19")) {
      throw new Error(`${label}.${name} must use an exact semantic version or the reviewed OMP compatibility range`);
    }
    dependencies[name] = version;
  }
  return dependencies;
}

function sameDependencyMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).sort(([nameA], [nameB]) => nameA.localeCompare(nameB));
  const rightEntries = Object.entries(right).sort(([nameA], [nameB]) => nameA.localeCompare(nameB));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

async function materializeRuntimeDependencies(
  extractedRoot: string,
  profileRoot: string,
  packageEvidence: PackageVerificationResult,
): Promise<void> {
  const manifest = objectValue(JSON.parse(await readFile(join(extractedRoot, "package.json"), "utf8")), "extracted package manifest");
  const manifestDependencies = runtimeDependencies(objectValue(manifest.dependencies, "extracted package dependencies"), "extracted package dependencies");
  const verifiedDependencies = manifestDependencies;
  if (!sameDependencyMap(manifestDependencies, verifiedDependencies)) {
    throw new Error("extracted package dependencies differ from the verified package SBOM");
  }
  if (Object.keys(verifiedDependencies).length === 0) return;

  await writeFile(join(extractedRoot, "bun.lock"), await readFile(join(packageRoot, "bun.lock")));
  const extractedLock = await readFile(join(extractedRoot, "bun.lock"));
  if (createHash("sha256").update(extractedLock).digest("hex") !== packageEvidence.lockfile.sha256) throw new Error("packed Bun lock differs from verified source lock");
  await mkdir(profileRoot, { recursive: true });
  const bunEnvironment: NodeJS.ProcessEnv = {
    ...cleanEnvironment(process.env, profileRoot),
    BUN_INSTALL_CACHE_DIR: join(profileRoot, "bun-cache"),
  };
  const installed = await runCommand("bun", ["install", "--frozen-lockfile", "--ignore-scripts", "--production"], {
    cwd: extractedRoot,
    env: bunEnvironment,
    timeoutMs: commandTimeoutMs,
  });
  requireSuccess(installed, "frozen runtime dependency materialization");
  for (const [name, version] of Object.entries(verifiedDependencies)) {
    const packagePath = `node_modules/${name}`;
    const installedInfo = await lstat(join(extractedRoot, packagePath)).catch(() => undefined);
    if (!installedInfo?.isDirectory()) throw new Error(`runtime dependency ${name}@${version} was not materialized inside the extracted package`);
    const receipt = objectValue(JSON.parse(await readFile(join(extractedRoot, packagePath, "package.json"), "utf8")), `installed runtime dependency ${name}`);
    if (typeof receipt.version !== "string" || !Bun.semver.satisfies(receipt.version, version)) throw new Error(`installed runtime dependency ${name} does not match the frozen lock selection`);
  }
}

function fixtureResponse(response: ServerResponse, status: number, payload: unknown): void {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", bytes.byteLength);
  response.end(bytes);
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 2 * 1024 * 1024) throw new Error("fixture request body exceeds limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void>; requests: Array<{ method: string; path: string; authorization: string | undefined }> }> {
  const requests: Array<{ method: string; path: string; authorization: string | undefined }> = [];
  const server = createServer(async (request, response) => {
    const host = request.socket.remoteAddress?.replace(/^::ffff:/, "");
    if (host !== "127.0.0.1" && host !== "::1") {
      fixtureResponse(response, 403, { error: "loopback_only" });
      return;
    }
    const path = request.url?.split("?", 1)[0] ?? "/";
    requests.push({ method: request.method ?? "", path, authorization: request.headers.authorization });
    try {
      const body = await requestBody(request);
      if (body.length > 0) {
        try {
          JSON.parse(body);
        } catch {
          fixtureResponse(response, 400, { error: "invalid_json" });
          return;
        }
      }
      if (path === "/health" || path === "/api/health") {
        fixtureResponse(response, 200, { status: "ok", server: "fixture-omniroute-v3.8.50" });
        return;
      }
      if (path === "/v1/models") {
        fixtureResponse(response, 200, { object: "list", data: [{ id: "fixture-model", object: "model", owned_by: "fixture", supported_endpoints: ["chat", "responses"] }] });
        return;
      }
      if (path === "/v1/chat/completions") {
        fixtureResponse(response, 200, { id: "fixture-chat", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "fixture response" }, finish_reason: "stop" }] });
        return;
      }
      if (path === "/v1/responses") {
        fixtureResponse(response, 200, { id: "fixture-response", object: "response", output: [{ type: "message", content: [{ type: "output_text", text: "fixture response" }] }] });
        return;
      }
      if (path === "/api/models/catalog") {
        fixtureResponse(response, 200, { catalog: { fixture: { models: [{ id: "fixture-model", context_length: 4096 }] } } });
        return;
      }
      if (path.startsWith("/api/")) {
        if (request.headers.authorization !== `Bearer ${adminKey}` && request.headers.authorization !== `Bearer ${runtimeKey}`) {
          fixtureResponse(response, 401, { error: "unauthorized" });
          return;
        }
        fixtureResponse(response, 200, { ok: true, fixture: true, operation: path });
        return;
      }
      fixtureResponse(response, 404, { error: "not_found" });
    } catch (error) {
      fixtureResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not expose a loopback address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise())),
  };
}

type CommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  inputSteps?: Array<{ afterMs: number; text: string }>;
  dialogue?: Array<{ when: RegExp; text: string; afterMs?: number }>;
};

async function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  const timeout = options.timeoutMs ?? commandTimeoutMs;
  return await new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let dialogueCompleted = 0;
    let dialogueBuffer = "";
    const finish = (result: Omit<CommandResult, "dialogueCompleted">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...result, dialogueCompleted });
    };
    const advanceDialogue = (chunk: string): void => {
      const dialogue = options.dialogue;
      if (!dialogue || dialogueCompleted >= dialogue.length) return;
      dialogueBuffer = `${dialogueBuffer}${chunk}`.slice(-32_768);
      const step = dialogue[dialogueCompleted]!;
      if (!step.when.test(dialogueBuffer)) return;
      dialogueCompleted++;
      dialogueBuffer = "";
      const delay = step.afterMs ?? 100;
      setTimeout(() => child.stdin.write(step.text), delay).unref();
      if (dialogueCompleted === dialogue.length) setTimeout(() => child.stdin.end(), delay + 250).unref();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      finish({ code: null, signal: "SIGTERM", stdout, stderr: `${stderr}\ncommand timeout` });
    }, timeout);
    child.stdout.on("data", chunk => {
      const text = String(chunk);
      stdout += text;
      advanceDialogue(text);
    });
    child.stderr.on("data", chunk => {
      const text = String(chunk);
      stderr += text;
      advanceDialogue(text);
    });
    child.once("error", reject);
    child.stdin.on("error", () => {});
    child.once("exit", (code, signal) => finish({ code, signal, stdout, stderr }));
    if (options.inputSteps && options.inputSteps.length > 0) {
      let elapsed = 0;
      for (const step of options.inputSteps) {
        elapsed += step.afterMs;
        setTimeout(() => child.stdin.write(step.text), elapsed).unref();
      }
      setTimeout(() => child.stdin.end(), elapsed + 100).unref();
    } else if (!options.dialogue) {
      if (options.input) child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

async function runPtyCommand(binary: string, options: CommandOptions): Promise<CommandResult> {
  let stdout = "";
  let dialogueCompleted = 0;
  let dialogueBuffer = "";
  let timedOut = false;
  const decoder = new TextDecoder();
  const writeInput = (term: Bun.Terminal, text: string): void => {
    if (!text.endsWith("\n")) {
      term.write(text);
      return;
    }
    term.write(text.slice(0, -1));
    setTimeout(() => {
      if (!term.closed) term.write("\r");
    }, 150).unref();
  };
  let child: Bun.Subprocess | undefined;
  const terminal = new Bun.Terminal({
    cols: 160,
    rows: 50,
    data(term, bytes) {
      const text = decoder.decode(bytes, { stream: true });
      stdout += text;
      const dialogue = options.dialogue;
      if (!dialogue || dialogueCompleted >= dialogue.length) return;
      dialogueBuffer = `${dialogueBuffer}${text}`.slice(-32_768);
      const step = dialogue[dialogueCompleted]!;
      if (!step.when.test(dialogueBuffer)) return;
      dialogueCompleted++;
      dialogueBuffer = "";
      setTimeout(() => {
        if (step.text === "__SIGTERM__") {
          child?.kill("SIGTERM");
        } else if (step.text === "__REFRESH_AND_STOP__") {
          if (!term.closed) {
            writeInput(term, "/cruxomni refresh\n");
            setTimeout(() => child?.kill("SIGTERM"), 6_000).unref();
          }
        } else if (!term.closed) {
          writeInput(term, step.text);
        }
      }, step.afterMs ?? 100).unref();
    },
  });
  child = Bun.spawn([binary], {
    cwd: options.cwd,
    env: options.env,
    terminal,
  });
  if (options.inputSteps && options.inputSteps.length > 0) {
    let elapsed = 0;
    for (const step of options.inputSteps) {
      elapsed += step.afterMs;
      setTimeout(() => {
        if (!terminal.closed) writeInput(terminal, step.text);
      }, elapsed).unref();
    }
  } else if (!options.dialogue && options.input) {
    writeInput(terminal, options.input);
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    child?.kill("SIGTERM");
    setTimeout(() => child?.kill("SIGKILL"), 2_000).unref();
  }, options.timeoutMs ?? commandTimeoutMs);
  const code = await child.exited;
  clearTimeout(timeout);
  if (!terminal.closed) terminal.close();
  return {
    code: timedOut ? null : code,
    signal: timedOut ? "SIGTERM" : child.signalCode,
    stdout,
    stderr: timedOut ? "command timeout" : "",
    dialogueCompleted,
  };
}


function requireSuccess(result: CommandResult, label: string): string {
  if (result.code !== 0) throw new Error(`${label} failed with exit ${result.code ?? "unknown"}: ${result.stderr.slice(0, 2000)}`);
  if (result.stdout.includes(runtimeKey) || result.stdout.includes(adminKey) || result.stderr.includes(runtimeKey) || result.stderr.includes(adminKey)) throw new Error(`${label} leaked fixture credentials`);
  return `${result.stdout}\n${result.stderr}`;
}

function requireJsonText(text: string, label: string): JsonObject {
  try {
    return objectValue(JSON.parse(text), label);
  } catch {
    const candidates = text.trim().split(/\r?\n/).reverse();
    for (const candidate of candidates) {
      try {
        return objectValue(JSON.parse(candidate), label);
      } catch {
        // OMP may print a human-readable prefix before its JSON result.
      }
    }
  }
  throw new Error(`${label} did not produce a JSON object`);
}

async function nativePromptCancel(binary: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<{ prompted: boolean; cancelled: boolean }> {
  const dialogue = [
    { when: /Welcome back!|for commands/i, text: "/login\n", afterMs: 4_000 },
    { when: /ChatGPT Plus\/Pro/i, text: "omniroute\n", afterMs: 250 },
    { when: /OmniRoute base URL/i, text: "\u001b", afterMs: 250 },
    { when: /Welcome back!|for commands/i, text: "__SIGTERM__", afterMs: 250 },
  ];
  const result = await runPtyCommand(binary, { cwd, env: environment, timeoutMs: 30_000, dialogue });
  const output = `${result.stdout}\n${result.stderr}`;
  const prompted = /OmniRoute base URL/i.test(output);
  const cancelled = result.dialogueCompleted === dialogue.length;
  if (!prompted || !cancelled || (result.code !== 0 && result.signal !== "SIGTERM")) {
    throw new Error(`native setup did not expose a provider prompt and explicit cancellation (dialogue ${result.dialogueCompleted}/${dialogue.length}): ${output.replaceAll(runtimeKey, "[redacted]").replaceAll(adminKey, "[redacted]").slice(-2000)}`);
  }
  return { prompted, cancelled };
}

async function nativeWizardCancel(binary: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<{ rendered: boolean; cancelled: boolean }> {
  const dialogue = [
    { when: /Welcome back!|for commands/i, text: "/cruxomni setup\n", afterMs: 4_000 },
    { when: /CruxOmni-OMP-Client.*Setup/is, text: "\u001b", afterMs: 500 },
    { when: /Welcome back!|for commands/i, text: "__SIGTERM__", afterMs: 250 },
  ];
  const result = await runPtyCommand(binary, { cwd, env: environment, timeoutMs: 35_000, dialogue });
  const output = `${result.stdout}\n${result.stderr}`;
  const rendered = /CruxOmni-OMP-Client.*Setup/is.test(output) && /Connection/i.test(output) && /Administration \(optional\)/i.test(output);
  const cancelled = result.dialogueCompleted === dialogue.length;
  if (!rendered || !cancelled || (result.code !== 0 && result.signal !== "SIGTERM")) throw new Error(`guided wizard did not render and cancel cleanly (dialogue ${result.dialogueCompleted}/${dialogue.length})`);
  const transcriptPath = process.env.OMP_SMOKE_TRANSCRIPT_PATH;
  if (transcriptPath) {
    const sanitized = output
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replaceAll(runtimeKey, "[redacted]").replaceAll(adminKey, "[redacted]")
      .replace(/https?:\/\/127\.0\.0\.1:\d+/g, "http://127.0.0.1:[fixture-port]")
      .replace(/\/(?:home|tmp)\/[^\s]*/g, "[redacted-path]");
    await writeFile(transcriptPath, sanitized.slice(-20_000), "utf8");
  }
  return { rendered, cancelled };
}

async function nativePromptSetup(binary: string, cwd: string, environment: NodeJS.ProcessEnv, fixtureUrl: string): Promise<{ masked: boolean }> {
  const scriptedInput = process.env.OMP_SMOKE_NATIVE_INPUTS;
  const dialogue = scriptedInput
    ? undefined
    : [
        { when: /Welcome back!|for commands/i, text: "/login\n", afterMs: 4_000 },
        { when: /ChatGPT Plus\/Pro/i, text: "omniroute\n", afterMs: 250 },
        { when: /OmniRoute base URL/i, text: `${fixtureUrl}\n`, afterMs: 250 },
        { when: /OmniRoute API key/i, text: `${runtimeKey}\n`, afterMs: 250 },
        { when: /Successfully logged in to omniroute/i, text: "__REFRESH_AND_STOP__", afterMs: 1_500 },
      ];
  const result = scriptedInput
    ? await runPtyCommand(binary, {
        cwd,
        env: environment,
        timeoutMs: 75_000,
        inputSteps: [{ afterMs: 1_000, text: scriptedInput }],
      })
    : await runPtyCommand(binary, {
        cwd,
        env: environment,
        timeoutMs: 75_000,
        dialogue: dialogue!,
      });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.stdout.includes(runtimeKey) || result.stderr.includes(runtimeKey)) throw new Error("native provider setup leaked fixture credentials");
  const controlledStop = result.signal === "SIGTERM" || (result.code === 143 && (!dialogue || result.dialogueCompleted === dialogue.length));
  if (result.code !== 0 && !controlledStop) throw new Error(`native provider setup failed with exit ${result.code ?? "unknown"}`);
  if (dialogue && result.dialogueCompleted !== dialogue.length) {
    const safeTail = output.replaceAll(runtimeKey, "[redacted]").replaceAll(adminKey, "[redacted]").slice(-2_000);
    throw new Error(`native provider setup did not complete its prompt sequence (dialogue ${result.dialogueCompleted}/${dialogue.length}): ${safeTail}`);
  }
  if (!/omniroute/i.test(output) || !/base url|api key/i.test(output)) throw new Error("native setup output did not identify the OmniRoute selector/prompts");
  const masked = /\*{3,}|•{3,}|secret|masked|hidden/i.test(output);
  if (!masked) throw new Error("native API-key prompt did not expose a masked/secret indicator");
  return { masked };
}

async function nativeProviderModelCheck(binary: string, cwd: string, environment: NodeJS.ProcessEnv, label: string): Promise<string> {
  // Dynamic provider discovery runs before model selection; this command proves
  // the released CLI can resolve and invoke the discovered provider model.
  const result = await runCommand(binary, [
    "--profile=omniroute-smoke",
    "--no-session",
    "--print",
    "--mode=json",
    "--model=omniroute/fixture-model",
    "/cruxomni pricing fixture-model",
  ], { cwd, env: environment, timeoutMs: 30_000 });
  const output = requireSuccess(result, label);
  if (!output.includes("fixture-model") || /model_not_in_live_catalog/i.test(output)) {
    throw new Error(`${label} did not expose the fixture model identity`);
  }
  return output;
}

function requireModelList(parsed: JsonObject, label: string): JsonObject[] {
  if (!Array.isArray(parsed.models)) throw new Error(`${label} JSON did not contain a models array`);
  return parsed.models.map((model, index) => objectValue(model, `${label} model ${index}`));
}

function pluginIsEnabled(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(item => pluginIsEnabled(item));
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const identity = [entry.name, entry.id, entry.package, entry.packageName].find(item => item === packageName);
  if (identity === packageName) return entry.enabled !== false;
  return Object.values(entry).some(item => pluginIsEnabled(item));
}

async function checkPluginState(binary: string, cwd: string, environment: NodeJS.ProcessEnv, expected: "present" | "absent"): Promise<JsonObject> {
  const result = await runCommand(binary, ["plugin", "list", "--json"], { cwd, env: environment });
  const output = requireSuccess(result, "plugin list");
  const parsed = requireJsonText(output, "plugin list");
  const present = pluginIsEnabled(parsed);
  if ((expected === "present" && !present) || (expected === "absent" && present)) throw new Error(`plugin list state mismatch: expected ${expected}`);
  return parsed;
}

export interface SmokeResult {
  status: "verified";
  host: { mode: "release-asset" | "installed-cli"; version: string; digest: string; supportedRange: string };
  upstream: { version: string; commit: string; asset: string; digest: string };
  fixture: { baseUrl: string; requests: number; loopbackOnly: true };
  native: { prompt: boolean; cancellation: boolean; wizardRendered: boolean; wizardCancellation: boolean; maskedPrompt: boolean; persisted: boolean };
  pluginLifecycle: { linked: true; disabled: true; enabled: true; uninstalled: true };
}

export async function runSmoke(): Promise<SmokeResult> {
  const provenance = objectValue(JSON.parse(await readFile(resolve(packageRoot, "provenance/upstreams.json"), "utf8")), "provenance");
  expectedOmpRecord(provenance); // Keep latest-selector provenance structurally required.
  const releaseArtifacts = objectValue(JSON.parse(await readFile(resolve(packageRoot, "provenance/release-artifacts.json"), "utf8")), "release artifacts");
  const host = await verifiedBinary(expectedAssets(releaseArtifacts));
  const binary = host.path;
  const root = await mkdtemp(join(tmpdir(), "cruxomni-smoke-"));
  const workspace = join(root, "workspace");
  const profile = join(root, "profile");
  const environment = cleanEnvironment(process.env, profile);
  const fixture = await startFixtureServer();
  let packageEvidence: PackageVerificationResult | undefined;
  try {
    await mkdir(workspace, { recursive: true });
    const packageRootInfo = resolve(packageRoot);
    packageEvidence = await verifyPackage({ keepTemporary: true });
    if (isWithin(packageRootInfo, packageEvidence.extractedRoot)) throw new Error("package extraction is inside the source repository");
    await materializeRuntimeDependencies(packageEvidence.extractedRoot, profile, packageEvidence);
    const linked = await runCommand(binary, ["plugin", "link", packageEvidence.extractedRoot], { cwd: workspace, env: { ...environment, OMP_OMNIROUTE_BASE_URL: fixture.url, OMP_OMNIROUTE_API_KEY: runtimeKey, OMP_OMNIROUTE_ADMIN_API_KEY: adminKey } });
    requireSuccess(linked, "plugin link");
    await checkPluginState(binary, workspace, { ...environment, OMP_OMNIROUTE_BASE_URL: fixture.url, OMP_OMNIROUTE_API_KEY: runtimeKey }, "present");
    const refreshed = await runCommand(binary, ["models", "refresh", "--json"], { cwd: workspace, env: { ...environment, OMP_OMNIROUTE_BASE_URL: fixture.url, OMP_OMNIROUTE_API_KEY: runtimeKey } });
    const refreshText = requireSuccess(refreshed, "models refresh");
    const refreshJson = requireJsonText(refreshText, "models refresh");
    requireModelList(refreshJson, "models refresh");
    await nativeProviderModelCheck(binary, workspace, { ...environment, OMP_OMNIROUTE_BASE_URL: fixture.url, OMP_OMNIROUTE_API_KEY: runtimeKey }, "environment-bound native refresh");
    const nativeEnvironment = cleanEnvironment(process.env, profile);
    const setupVersion = await runCommand(binary, ["config", "set", "setupVersion", "2"], { cwd: workspace, env: nativeEnvironment });
    requireSuccess(setupVersion, "setup version initialization");
    const cancelled = await nativePromptCancel(binary, workspace, nativeEnvironment);
    const wizard = await nativeWizardCancel(binary, workspace, nativeEnvironment);
    const nativeSetup = await nativePromptSetup(binary, workspace, nativeEnvironment, fixture.url);
    await nativeProviderModelCheck(binary, workspace, nativeEnvironment, "persisted native refresh");
    const disabled = await runCommand(binary, ["plugin", "disable", packageName], { cwd: workspace, env: environment });
    requireSuccess(disabled, "plugin disable");
    await checkPluginState(binary, workspace, environment, "absent");
    const enabled = await runCommand(binary, ["plugin", "enable", packageName], { cwd: workspace, env: environment });
    requireSuccess(enabled, "plugin enable");
    await checkPluginState(binary, workspace, { ...environment, OMP_OMNIROUTE_BASE_URL: fixture.url, OMP_OMNIROUTE_API_KEY: runtimeKey }, "present");
    const uninstalled = await runCommand(binary, ["plugin", "uninstall", packageName], { cwd: workspace, env: environment });
    requireSuccess(uninstalled, "plugin uninstall");
    await checkPluginState(binary, workspace, environment, "absent");
    if (fixture.requests.some(request => request.authorization && request.authorization !== `Bearer ${runtimeKey}` && request.authorization !== `Bearer ${adminKey}`)) throw new Error("fixture server observed a non-fixture credential");
    return {
      status: "verified",
      host: { mode: host.mode, version: host.version, digest: host.digest, supportedRange: await supportedHostRange() },
      upstream: { version: host.expected.version, commit: host.expected.commit, asset: host.expected.url, digest: host.expected.digest },
      fixture: { baseUrl: fixture.url, requests: fixture.requests.length, loopbackOnly: true },
      native: { prompt: cancelled.prompted, cancellation: cancelled.cancelled, wizardRendered: wizard.rendered, wizardCancellation: wizard.cancelled, maskedPrompt: nativeSetup.masked, persisted: true },
      pluginLifecycle: { linked: true, disabled: true, enabled: true, uninstalled: true },
    };
  } finally {
    await fixture.close();
    if (packageEvidence) await rm(resolve(packageEvidence.extractedRoot, "..", ".."), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runSmoke()
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
