import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Family, Usage } from "../shared/model";
import { providerCommand } from "./binaries";
import { run } from "./process";

export const QUOTA_PING_INTERVAL_MS = 5 * 60 * 60_000;
export const QUOTA_PING_TEXT = "Reply OK.";

/** Unknown, cached and failed readings must never be interpreted as an idle account. */
export function hasIdleQuotaWindow(family: Family, usage: Usage, now = Date.now()): boolean {
  if (usage.error || usage.cached) return false;
  const fetchedAt = Date.parse(usage.fetchedAt);
  if (!Number.isFinite(fetchedAt) || fetchedAt > now || now - fetchedAt > 2 * 60_000) return false;
  const primary = usage.windows.find((window) => window.id === (family === "claude" ? "five_hour" : "primary"));
  if (!primary || primary.usedPercent !== 0) return false;
  if (usage.windows.some((window) => !Number.isFinite(window.usedPercent) || window.usedPercent >= 100)) return false;
  // A weekly window may still be running while the five-hour window is idle.
  if (primary.resetsAt === null) return true;
  const resetsAt = Date.parse(primary.resetsAt);
  return Number.isFinite(resetsAt) && resetsAt <= now;
}

/** The official CLI keeps ownership of subscription authentication and token renewal. */
export async function sendQuotaPing(family: Family, env: NodeJS.ProcessEnv, model: string): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "zerosub-ping-"));
  try {
    // Even the main account must use its stored login, not an inherited API key or OAuth override.
    const loginEnv = { ...env };
    for (const key of [
      "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
      "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN",
      "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL",
    ]) delete loginEnv[key];
    const { command, prefix } = await providerCommand(family);
    const args = family === "claude"
      ? ["-p", "--model", model, "--no-session-persistence", "--tools", "", "--max-turns", "1",
          "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--strict-mcp-config",
          "--disable-slash-commands", "--system-prompt", "Reply with OK.", QUOTA_PING_TEXT]
      : ["exec", "--model", model, "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
          "--sandbox", "read-only", "--disable", "shell_tool", "-c", 'model_reasoning_effort="low"',
          "-c", 'developer_instructions="Reply with OK. Do not use tools."', QUOTA_PING_TEXT];
    const result = await run(command, [...prefix, ...args], { env: loginEnv, cwd, timeoutMs: 60_000 });
    // CLI output can contain account information; don't log it in background upkeep errors.
    if (result.timedOut) throw new Error("Quota ping timed out; another attempt will wait five hours.");
    if (result.code !== 0) throw new Error("Quota ping failed; check the account's sign-in and selected model.");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
