import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Reopener } from "./reopen";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

let home: string;
let reopener: Reopener;
const calls: string[][] = [];
type Reply = { code?: string; message?: string; stdout?: string; stderr?: string; killed?: boolean };
type SubprocessCallback = (error: Error | null, stdout: string, stderr: string) => void;

function replies(...results: Reply[]): void {
  vi.mocked(execFile).mockImplementation(((_cli: string, args: string[], _options: unknown, done: SubprocessCallback) => {
    calls.push(args);
    const reply = results.shift();
    if (!reply) throw new Error("Unexpected subprocess invocation");
    done(reply.code ? Object.assign(new Error(reply.message ?? "exit 1"), { code: reply.code, killed: reply.killed }) : null,
      reply.stdout ?? "", reply.stderr ?? "");
    return {};
  }) as typeof execFile);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "zerosub-reopen-"));
  vi.stubEnv("PASEO_HOME", home);
  vi.stubEnv("PASEO_LISTEN", "");
  calls.length = 0;
  reopener = new Reopener();
  vi.spyOn(reopener, "locate").mockResolvedValue("/fixture/paseo");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

it("reopens through the endpoint published in the plugin's home despite a false local stopped verdict", async () => {
  await writeFile(join(home, "paseo.pid"), JSON.stringify({ listen: "127.0.0.1:6767", startedAt: "2000-01-01T00:00:00Z" }));
  vi.mocked(execFile).mockImplementation(((_cli: string, args: string[], _options: unknown, done: SubprocessCallback) => {
    calls.push(args);
    if (args.includes("--home")) done(new Error("exit 1"), "", JSON.stringify({ error: { code: "DAEMON_NOT_RUNNING", message: "False stopped verdict" } }));
    else done(null, JSON.stringify({ agentId: "scout", status: "reloaded" }), "");
    return {};
  }) as typeof execFile);
  expect(await reopener.reopen("scout")).toEqual({ ok: true });
  expect(calls).toEqual([["agent", "reload", "scout", "--json", "--host", "127.0.0.1:6767"]]);
});

it("prefers the published listener over configured addresses and rereads it after a daemon update", async () => {
  vi.stubEnv("PASEO_LISTEN", "127.0.0.1:7001");
  await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: "127.0.0.1:7002" } }));
  await writeFile(join(home, "paseo.pid"), JSON.stringify({ listen: "127.0.0.1:7003" }));
  replies({}, {});
  expect(await reopener.reopen("scout")).toEqual({ ok: true });
  await writeFile(join(home, "paseo.pid"), JSON.stringify({ listen: "127.0.0.1:7004" }));
  expect(await reopener.reopen("scout")).toEqual({ ok: true });
  expect(calls.map((args) => args.slice(-2))).toEqual([["--host", "127.0.0.1:7003"], ["--host", "127.0.0.1:7004"]]);
});

it("keeps the home command when no endpoint is published or configured", async () => {
  replies({});
  expect(await reopener.reopen("scout")).toEqual({ ok: true });
  expect(calls[0]).toEqual(["agent", "reload", "scout", "--json", "--home", home]);
  expect(calls).toHaveLength(1);
});

it("retries a refused endpoint once by home and reports both structured failures", async () => {
  await writeFile(join(home, "paseo.pid"), JSON.stringify({ listen: "127.0.0.1:6767" }));
  replies(
    { code: "1", stderr: JSON.stringify({ error: { code: "DAEMON_UNREACHABLE", message: "Connection refused", details: "Check the endpoint." } }, null, 2) },
    { code: "1", stderr: JSON.stringify({ error: { code: "DAEMON_NOT_RUNNING", message: "Local detector reports stopped", details: "Start with: paseo daemon start" } }, null, 2) },
  );
  const result = await reopener.reopen("scout");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected failure");
  expect(result.error).toContain("DAEMON_UNREACHABLE: Connection refused");
  expect(result.error).toContain("Check the endpoint.");
  expect(result.error).toContain("DAEMON_NOT_RUNNING: Local detector reports stopped");
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(["agent", "reload", "scout", "--json", "--home", home]);
});

it.each(["AGENT_NOT_FOUND", "RELOAD_FAILED", "agent_refresh_failed"])("does not retry operation error %s and replaces its misleading start hint", async (code) => {
  await writeFile(join(home, "paseo.pid"), JSON.stringify({ listen: "127.0.0.1:6767" }));
  replies({ code: "1", stdout: JSON.stringify({ error: { code, message: "Unknown scout", details: "Start with: paseo daemon start" } }) });
  const result = await reopener.reopen("scout");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected failure");
  expect(result.error).toContain(`${code}: Unknown scout`);
  expect(result.error).not.toContain("Start with:");
  expect(result.error).toContain("daemon responded");
  expect(calls).toHaveLength(1);
});

it("does not retry a timed-out reload that may still be running", async () => {
  await writeFile(join(home, "paseo.pid"), JSON.stringify({ listen: "127.0.0.1:6767" }));
  replies({ code: "ETIMEDOUT", killed: true, message: "Reload timed out" });
  expect(await reopener.reopen("scout")).toMatchObject({ ok: false, timedOut: true });
  expect(calls).toHaveLength(1);
});

it("uses PASEO_LISTEN when the PID record is incomplete, converting wildcard listeners to loopback", async () => {
  await writeFile(join(home, "paseo.pid"), "{}");
  vi.stubEnv("PASEO_LISTEN", "0.0.0.0:7001");
  replies({});
  expect(await reopener.reopen("scout")).toEqual({ ok: true });
  expect(calls[0]?.slice(-2)).toEqual(["--host", "127.0.0.1:7001"]);
});

it("uses configured listen when neither the PID record nor environment publishes an endpoint", async () => {
  await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: "[::]:7002" } }));
  replies({});
  expect(await reopener.reopen("scout")).toEqual({ ok: true });
  expect(calls[0]?.slice(-2)).toEqual(["--host", "[::1]:7002"]);
});

it("reports the endpoint failure even when the single home retry succeeds", async () => {
  vi.stubEnv("PASEO_LISTEN", "127.0.0.1:7001");
  replies({ code: "ECONNREFUSED", message: "Connection refused" }, {});
  expect(await reopener.reopen("scout")).toMatchObject({ ok: true, detail: expect.stringContaining("Home retry: reopen succeeded.") });
  expect(calls).toHaveLength(2);
});

it.each(["AUTH_REQUIRED", "AUTH_FAILED"])("retries %s through the home's local credentials without putting credentials in argv", async (code) => {
  vi.stubEnv("PASEO_LISTEN", "127.0.0.1:7001");
  vi.stubEnv("PASEO_PASSWORD", "fixture-password");
  replies({ code: "1", stderr: JSON.stringify({ error: { code, message: "Endpoint authentication rejected" } }) }, {});
  const result = await reopener.reopen("scout");
  expect(result).toMatchObject({ ok: true, detail: expect.stringContaining(`${code}: Endpoint authentication rejected`) });
  expect(result).toMatchObject({ detail: expect.stringContaining("Home retry: reopen succeeded.") });
  expect(calls).toEqual([
    ["agent", "reload", "scout", "--json", "--host", "127.0.0.1:7001"],
    ["agent", "reload", "scout", "--json", "--home", home],
  ]);
  expect(JSON.stringify(calls)).not.toContain("fixture-password");
});

it.each([
  "error: unknown option '--host'",
  "error: invalid argument for --host",
  "Usage: paseo agent reload <id>",
])("retries a CLI compatibility failure through home: %s", async (stderr) => {
  vi.stubEnv("PASEO_LISTEN", "127.0.0.1:7001");
  replies({ code: "1", stderr }, {});
  expect(await reopener.reopen("scout")).toMatchObject({ ok: true, detail: expect.stringContaining(stderr) });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(["agent", "reload", "scout", "--json", "--home", home]);
});

it.each(["DAEMON_REQUEST_TIMEOUT", "ETIMEDOUT"])("does not double-send a %s even when the subprocess was not killed", async (code) => {
  vi.stubEnv("PASEO_LISTEN", "127.0.0.1:7001");
  replies({ code: "1", stderr: JSON.stringify({ error: { code, message: "Reload timed out" } }) });
  expect(await reopener.reopen("scout")).toMatchObject({ ok: false, timedOut: true });
  expect(calls).toHaveLength(1);
});

it("keeps credentials out of arguments and redacts them from both structured and raw errors", async () => {
  vi.stubEnv("PASEO_PASSWORD", "fixture-password");
  vi.stubEnv("PASEO_LISTEN", "127.0.0.1:7001");
  await writeFile(join(home, "paseo.pid"), JSON.stringify({ listen: "tcp://user:fixture-password@127.0.0.1:6767?token=fixture-token" }));
  replies({ code: "1", stderr: JSON.stringify({ error: {
    code: "AUTH_FAILED", message: "Authorization: Bearer fixture-token", details: "password=fixture-password",
  } }) }, { code: "1", stderr: "Home authentication failed" });
  const result = await reopener.reopen("scout");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected failure");
  expect(calls[0]?.slice(-2)).toEqual(["--host", "127.0.0.1:7001"]);
  expect(JSON.stringify(calls)).not.toMatch(/fixture-password|fixture-token/);
  expect(result.error).toContain("AUTH_FAILED");
  expect(result.error).not.toMatch(/fixture-password|fixture-token/);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.slice(-2)).toEqual(["--home", home]);
});

it("bounds raw diagnostics while preserving a structured error before trailing log lines", async () => {
  replies({ code: "1", stderr: JSON.stringify({ error: { code: "RELOAD_FAILED", message: "Provider failed", details: "Check provider output" } }, null, 2) + "\n" + "log line\n".repeat(500) });
  const result = await reopener.reopen("scout");
  if (result.ok) throw new Error("Expected failure");
  expect(result.error).toContain("RELOAD_FAILED: Provider failed");
  expect(result.error.length).toBeLessThan(1600);
});
