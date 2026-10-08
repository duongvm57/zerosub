import { execFile } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { paseoHome } from "./paths";

type ReopenResult = { ok: true; detail?: string } | { ok: false; error: string; timedOut: boolean };
type Attempt = { ok: true } | {
  ok: false; error: string; timedOut: boolean; operationError: boolean;
};

/**
 * Reopens an agent's provider session so it picks up a new account.
 *
 * The plugin SDK has no session reopen (`agents.ref(id).refresh()` only refetches data), so this
 * uses the bundled CLI's `paseo agent reload`, which the daemon implements as close + reopen with
 * the current configuration. Prefer the published endpoint: local CLI detection can mistake a
 * running daemon for an abandoned PID lock after clock changes. Authentication stays with the CLI.
 */
export class Reopener {
  private cli: { at: number; path: Promise<string | null> } | null = null;

  /** Path to the CLI, or null when none can be found (looked for again every few minutes). */
  async locate(): Promise<string | null> {
    if (this.cli && (Date.now() - this.cli.at < 5 * 60_000 || (await this.cli.path) !== null)) return this.cli.path;
    this.cli = { at: Date.now(), path: findCli() };
    return this.cli.path;
  }

  /** `timedOut`: the command was stopped before the daemon answered, so the reload may still finish. */
  async reopen(agentId: string): Promise<ReopenResult> {
    const cli = await this.locate();
    if (!cli) return { ok: false, error: "The paseo command-line tool was not found on the daemon machine.", timedOut: false };
    const endpoint = await publishedEndpoint();
    const first = await this.run(cli, agentId, endpoint ? ["--host", endpoint] : ["--home", paseoHome()]);
    if (first.ok) return { ok: true };
    if (!endpoint || first.operationError || first.timedOut) return { ok: false, error: first.error, timedOut: first.timedOut };
    const fallback = await this.run(cli, agentId, ["--home", paseoHome()]);
    const detail = `Endpoint ${endpoint} failed: ${first.error}\nHome retry: ${fallback.ok ? "reopen succeeded." : fallback.error}`;
    return fallback.ok ? { ok: true, detail } : { ok: false, error: detail, timedOut: fallback.timedOut };
  }

  private run(cli: string, agentId: string, target: string[]): Promise<Attempt> {
    return new Promise((resolve) => {
      execFile(
        cli,
        ["agent", "reload", agentId, "--json", ...target],
        { timeout: 90_000, maxBuffer: 1024 * 1024, env: process.env },
        (error, stdout, stderr) => {
          const structured = parseError(stderr) ?? parseError(stdout);
          if (!error && !structured) return resolve({ ok: true });
          const code = structured?.code ?? error?.code;
          const message = structured?.message ?? error?.message ?? "Reload failed.";
          // Only a recognized operation reply proves the reload reached the daemon. AUTH_*,
          // CLI flag/usage errors and connection failures must retain the old home path.
          const operationError = structured !== null
            && /^(AGENT_NOT_FOUND|RELOAD_FAILED|agent_refresh_failed|worktree_[a-z_]+)$/.test(String(code));
          // Both a CLI deadline and an RPC deadline may leave a reload running in the daemon.
          const timedOut = error?.killed === true || /^(ETIMEDOUT|DAEMON_REQUEST_TIMEOUT)$/.test(String(code));
          const responded = target[0] === "--host" && operationError;
          const clean = (text: string) => responded
            ? text.replace(/Start with:\s*paseo daemon start[^\r\n]*/gi, "The daemon responded on its endpoint; check the operation error.")
            : text;
          const hint = structured?.details;
          const primary = redact(clean(`${code ? `${code}: ` : ""}${message}${hint ? `\nHint: ${hint}` : ""}`)).slice(0, 2400);
          const tail = redact(clean(stderr || stdout)).trim().split("\n").slice(-6).join("\n").slice(-1200);
          resolve({ ok: false, error: `${primary}${tail ? `\nCLI detail: ${tail}` : ""}`, timedOut, operationError });
        },
      );
    });
  }
}

async function publishedEndpoint(): Promise<string | null> {
  // The server plugin context exposes no listener. Read the supervisor's published address
  // without asking the CLI to validate its wall-clock-based PID ownership heuristic.
  const home = paseoHome();
  const lock = await readObject(join(home, "paseo.pid"));
  const published = normalizeEndpoint(lock?.listen);
  if (published) return published;
  const environment = normalizeEndpoint(process.env.PASEO_LISTEN);
  if (environment) return environment;
  const config = await readObject(join(home, "config.json"));
  const daemon = config?.daemon as Record<string, unknown> | undefined;
  return normalizeEndpoint(daemon?.listen ?? config?.listen);
}

async function readObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function normalizeEndpoint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const endpoint = value.trim().replace(/^tcp:\/\//, "");
  // Never carry authentication embedded in a URI into argv. The CLI owns authentication.
  if (!endpoint || /[\s@?#]/.test(endpoint)) return null;
  if (endpoint.startsWith("unix:///") || endpoint.startsWith("/") || endpoint.startsWith("pipe://")) return endpoint;
  const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9_.-]+):(\d+)$/.exec(endpoint);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return null;
  const host = match[1] === "0.0.0.0" ? "127.0.0.1" : match[1] === "[::]" ? "[::1]" : match[1];
  return `${host}:${match[2]}`;
}

function redact(text: string): string {
  // Provider/CLI errors can echo inherited credentials. Redact before bounding the raw tail,
  // so truncation cannot hide a prefix and leave its value behind.
  for (const [key, value] of Object.entries(process.env)) {
    if (/password|token|secret|api_?key|authorization/i.test(key) && value) text = text.split(value).join("<REDACTED>");
  }
  return text
    .replace(/\bBearer\s+[^\s"'\\,}]+/gi, "Bearer <REDACTED>")
    .replace(/((?:password|[\w-]*token|secret|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)([^\s"'\\,}]+)/gi, "$1<REDACTED>")
    .replace(/(\w+:\/\/)[^\s/@]+@/g, "$1<REDACTED>@");
}

function parseError(text: string): { code?: string; message: string; details?: string } | null {
  for (const raw of [text.trim(), text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    try {
      const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown; details?: unknown } };
      const error = parsed?.error;
      if (typeof error?.message === "string") return {
        message: error.message,
        code: typeof error.code === "string" ? error.code : undefined,
        details: typeof error.details === "string" ? error.details : undefined,
      };
    } catch {
      // Older CLI versions may only emit plain text.
    }
  }
  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findCli(): Promise<string | null> {
  const candidates: string[] = [];
  const executable = process.platform === "win32" ? "paseo.cmd" : "paseo";

  // The daemon (and this subprocess) usually run inside the desktop app bundle, which ships the CLI.
  const exec = process.execPath;
  const appContents = exec.match(/^(.*?\.app\/Contents)\//)?.[1];
  if (appContents) candidates.push(join(appContents, "Resources", "bin", "paseo"));
  const resources = findAncestor(exec, "resources");
  if (resources) candidates.push(join(resources, "bin", executable));

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory) candidates.push(join(directory, executable));
  }

  if (process.platform === "darwin") {
    candidates.push("/Applications/Paseo.app/Contents/Resources/bin/paseo");
    candidates.push(join(homedir(), "Applications", "Paseo.app", "Contents", "Resources", "bin", "paseo"));
  }
  candidates.push(join(homedir(), ".local", "bin", executable));

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function findAncestor(path: string, name: string): string | null {
  let current = dirname(path);
  for (let depth = 0; depth < 6; depth += 1) {
    if (current.toLowerCase().endsWith(`/${name}`) || current.toLowerCase().endsWith(`\\${name}`)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
