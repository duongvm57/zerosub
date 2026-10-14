import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Family, Usage } from "../shared/model";
import { preferences } from "../shared/preferences";
import type { FamilyAdapter } from "./adapter";
import { hasIdleQuotaWindow, QUOTA_PING_INTERVAL_MS, QUOTA_PING_TEXT, sendQuotaPing } from "./ping";
import { run } from "./process";
import { Service } from "./service";
import { StateStore, StoredAccountSchema, type StoredAccount } from "./state";

vi.mock("./binaries", () => ({ providerCommand: async (family: string) => ({ command: family, prefix: [] }) }));
vi.mock("./process", async (original) => ({
  ...await original<typeof import("./process")>(),
  run: vi.fn(async () => ({ code: 0, stdout: "OK", stderr: "", timedOut: false })),
}));

const NOW = Date.parse("2026-10-14T06:00:00Z");
const reading = (family: Family = "claude", patch: Partial<Usage> = {}): Usage => ({
  fetchedAt: new Date(NOW).toISOString(),
  windows: [
    { id: family === "claude" ? "five_hour" : "primary", label: "5-hour", usedPercent: 0, resetsAt: null },
    { id: family === "claude" ? "seven_day" : "secondary", label: "Weekly", usedPercent: 20, resetsAt: new Date(NOW + 86_400_000).toISOString() },
  ],
  cached: false,
  error: null,
  resets: null,
  ...patch,
});

let root: string;
const services: Service[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-ping-test-"));
  vi.stubEnv("PASEO_HOME", root);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.mocked(run).mockClear();
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("idle quota detection", () => {
  it.each(["claude", "codex"] as const)("starts an idle %s five-hour window even with an active weekly window", (family) => {
    expect(hasIdleQuotaWindow(family, reading(family), NOW)).toBe(true);
    const usage = reading(family);
    usage.windows[0]!.resetsAt = new Date(NOW - 1).toISOString();
    expect(hasIdleQuotaWindow(family, usage, NOW)).toBe(true);
  });

  it("skips active, ambiguous, stale, cached, failed and exhausted readings", () => {
    for (const usage of [
      reading("claude", { windows: [] }),
      reading("claude", { fetchedAt: "invalid" }),
      reading("claude", { fetchedAt: new Date(NOW - 3 * 60_000).toISOString() }),
      reading("claude", { fetchedAt: new Date(NOW + 1).toISOString() }),
      reading("claude", { cached: true }),
      reading("claude", { error: "rate limited" }),
      reading("claude", { windows: [{ id: "five_hour", label: "5-hour", usedPercent: 0, resetsAt: "invalid" }] }),
      reading("claude", { windows: [{ id: "five_hour", label: "5-hour", usedPercent: 0, resetsAt: new Date(NOW + 60_000).toISOString() }] }),
      reading("claude", { windows: [{ id: "five_hour", label: "5-hour", usedPercent: 1, resetsAt: null }] }),
      reading("claude", { windows: [...reading().windows, { id: "seven_day_opus", label: "Opus", usedPercent: 100, resetsAt: null }] }),
    ]) expect(hasIdleQuotaWindow("claude", usage, NOW)).toBe(false);
  });
});

async function harness(family: Family = "claude", patch: Partial<StoredAccount> = {}) {
  const store = new StateStore(join(root, `state-${services.length}.json`));
  const account = StoredAccountSchema.parse({
    id: `${family}-work`, family, label: "work", kind: "managed", home: join(root, family),
    createdAt: new Date(NOW).toISOString(), ...patch,
  });
  await store.update((state) => { state.accounts = [account]; });
  const ping = vi.fn(async () => undefined);
  const usage = vi.fn(async () => reading(family));
  const adapter = { usageSpacingMs: 0, usage, ping, prepareHome: vi.fn(async () => undefined) } as unknown as FamilyAdapter;
  const service = new Service({ claude: adapter, codex: adapter }, store);
  services.push(service);
  const enable = () => service.setPreferences(preferences.schema.parse({
    autoPing: true, pingAccountIds: [account.id], claudePingModel: "claude-choice", codexPingModel: "codex-choice",
  }));
  const settle = async () => {
    await service.refreshUsage(account.id, true);
    // A ping is background work; a registry read synchronizes its atomic claim.
    await vi.waitFor(() => expect(ping).toHaveBeenCalledTimes(1));
  };
  return { store, account, service, adapter, ping, usage, enable, settle };
}

describe("automatic quota pings", () => {
  it("defaults to off with no accounts selected and preserves old preferences", async () => {
    expect(preferences.schema.parse({ autoSwitch: false })).toMatchObject({ autoSwitch: false, autoPing: false, pingAccountIds: [] });
    const { service, account, ping, store } = await harness();
    await service.refreshUsage(account.id, true);
    await service.stop();
    expect(ping).not.toHaveBeenCalled();
    expect((await store.read()).accounts[0]!.lastQuotaPingAt).toBeNull();
  });

  it.each(["claude", "codex"] as const)("sends one %s ping using the selected home and model", async (family) => {
    const { service, account, ping, store, enable, settle } = await harness(family);
    enable();
    await Promise.all([settle(), service.refreshUsage(account.id, true)]);
    expect(ping).toHaveBeenCalledWith(account.home, `${family}-choice`);
    expect((await store.read()).accounts[0]!.lastQuotaPingAt).toBe(new Date(NOW).toISOString());
    vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
    await service.refreshUsage(account.id, true);
    await service.stop();
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it.each([
    { disabled: true }, { signedIn: false },
    { limitedUntil: new Date(NOW + 60_000).toISOString(), limitKind: "budget" as const },
  ])("skips an unavailable account %j", async (patch) => {
    const { service, account, ping, enable } = await harness("claude", patch);
    enable();
    await service.refreshUsage(account.id, true);
    await service.stop();
    expect(ping).not.toHaveBeenCalled();
  });

  it("skips unselected accounts and failed/cached readings", async () => {
    const { service, account, ping, usage, enable } = await harness();
    service.setPreferences(preferences.schema.parse({ autoPing: true, pingAccountIds: ["other-account"] }));
    await service.refreshUsage(account.id, true);
    enable();
    vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
    usage.mockResolvedValue(reading("claude", { cached: true }));
    await service.refreshUsage(account.id, true);
    vi.mocked(Date.now).mockReturnValue(NOW + 120_000);
    usage.mockResolvedValue(reading("claude", { error: "offline" }));
    await service.refreshUsage(account.id, true);
    await service.stop();
    expect(ping).not.toHaveBeenCalled();
  });

  it("keeps the five-hour guard through uncertain failure and service restart", async () => {
    const { service, account, adapter, ping, usage, enable } = await harness();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ping.mockRejectedValueOnce(new Error("timeout"));
    enable();
    await service.refreshUsage(account.id, true);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    await service.stop();
    const restarted = new Service({ claude: adapter, codex: adapter }, new StateStore(join(root, "state-0.json")));
    services.push(restarted);
    restarted.setPreferences(preferences.schema.parse({ autoPing: true, pingAccountIds: [account.id] }));
    vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
    await restarted.refreshUsage(account.id, true);
    expect(ping).toHaveBeenCalledTimes(1);
    const later = NOW + QUOTA_PING_INTERVAL_MS;
    vi.mocked(Date.now).mockReturnValue(later);
    usage.mockResolvedValue(reading("claude", { fetchedAt: new Date(later).toISOString() }));
    await restarted.refreshUsage(account.id, true);
    await vi.waitFor(() => expect(ping).toHaveBeenCalledTimes(2));
    const saved = await new StateStore(join(root, "state-0.json")).read();
    expect(saved.accounts[0]!.lastQuotaPingAt).toBe(new Date(later).toISOString());
  });
});

describe("official CLI ping", () => {
  it.each(["claude", "codex"] as const)("uses %s subscription auth, an empty temporary directory and the chosen model", async (family) => {
    await sendQuotaPing(family, { CODEX_HOME: "/selected/codex", CLAUDE_CONFIG_DIR: "/selected/claude", OPENAI_API_KEY: "override", ANTHROPIC_API_KEY: "override" }, "chosen-model");
    const [command, args, options] = vi.mocked(run).mock.calls[0]!;
    expect(command).toBe(family);
    expect(args).toContain("chosen-model");
    expect(args).toContain(QUOTA_PING_TEXT);
    expect(args).toContain(family === "claude" ? "--no-session-persistence" : "--ephemeral");
    expect(options?.env).toMatchObject({ CODEX_HOME: "/selected/codex", CLAUDE_CONFIG_DIR: "/selected/claude" });
    expect(options?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(options?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(options?.cwd).toContain("zerosub-ping-");
    await expect(access(options!.cwd!)).rejects.toThrow();
  });

  it("cleans up and reports failures without exposing CLI output", async () => {
    vi.mocked(run).mockResolvedValueOnce({ code: 1, stdout: "private account", stderr: "private token", timedOut: false });
    await expect(sendQuotaPing("claude", {}, "bad-model")).rejects.toThrow("check the account's sign-in and selected model");
    await expect(access(vi.mocked(run).mock.calls[0]![2]!.cwd!)).rejects.toThrow();
  });
});
