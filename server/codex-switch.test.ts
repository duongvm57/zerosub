import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FamilyAdapter, LimitHit, UsageRead } from "./adapter";
import { CodexAdapter } from "./codex";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore } from "./state";

const AGENT = "codex-agent";
const MAIN = MAIN_ACCOUNT_ID.codex;
const WORK = "codex-work";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-codex-switch-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function account(id: string, label: string, home: string | null) {
  return {
    id,
    family: "codex" as const,
    label,
    autoLabel: false,
    kind: home ? ("managed" as const) : ("main" as const),
    home,
    email: null,
    plan: null,
    organization: null,
    identity: null,
    signedIn: true,
    disabled: false,
    limitedUntil: null,
    limitKind: null,
    limitedAt: null,
    createdAt: "2026-09-23T00:00:00.000Z",
  };
}

interface HarnessOptions {
  reload?: "works" | "fails";
  limit?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((state) => {
    state.accounts = [account(MAIN, "personal", null), account(WORK, "work", join(root, "codex-work"))];
    state.defaults = { claude: null, codex: MAIN };
    state.bindings = { [AGENT]: { accountId: MAIN, source: "thread", at: new Date().toISOString() } };
    state.sessions = { [AGENT]: { accountId: MAIN, family: "codex", openedAt: "2026-09-23T07:00:00.000Z" } };
  });

  const agent = {
    id: AGENT,
    provider: "codex",
    status: "idle",
    archivedAt: null,
    lastUserMessageAt: "2026-09-23T07:00:00.000Z",
  };
  const notes: Array<Record<string, unknown>> = [];
  const created: unknown[] = [];
  const events: string[] = [];
  const sent: string[] = [];
  const reloads: string[] = [];
  const envs: Array<Record<string, string | undefined>> = [];
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: () => ({
        refresh: async () => ({ agent }),
        send: async (text: string) => void sent.push(text),
        timeline: {
          append: async (item: { data: Record<string, unknown> }) => void notes.push(item.data),
          refetch: async () => ({ entries: [] }),
        },
      }),
      create: async (request: unknown) => void created.push(request),
    },
  };

  let service!: Service;
  const reading: UsageRead = { fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null };
  const hit: LimitHit = { kind: "window", resetsAt: new Date(Date.now() + 30 * 60_000).toISOString(), message: "Codex limit" };
  const adapter = {
    family: "codex" as const,
    portable: new CodexAdapter().portable,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async (home: string) => void events.push(`prepare:${home}`),
    env: async (home: string | null) => {
      events.push(`env:${home}`);
      return { CODEX_HOME: home, CODEX_SQLITE_HOME: "/shared/codex-sqlite" };
    },
    identity: async () => null,
    usage: async () => reading,
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async () => {
      throw new Error("not in tests");
    },
    logout: async () => undefined,
    detectLimit: () => (options.limit ? hit : null),
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
  const context = { paseo } as never;
  const reopener = {
    locate: async () => "/usr/local/bin/paseo",
    reopen: async (id: string) => {
      reloads.push(id);
      expect(id).toBe(AGENT);
      const request = await service.onSessionOpen(
        { agentId: AGENT, provider: "codex", reason: "refresh", purpose: "interactive", env: { INHERITED: "1" } } as never,
        context,
      );
      envs.push(request?.env ?? {});
      return options.reload === "fails"
        ? { ok: false as const, error: "Paseo daemon rejected reload", timedOut: false }
        : { ok: true as const };
    },
  } as unknown as Reopener;
  service = new Service(
    { claude: adapter, codex: adapter },
    store,
    { resolve: async () => ({ codex: "codex" as const }) } as unknown as FamilyResolver,
    reopener,
  );
  const result = { service, store, paseo, notes, created, events, envs, sent, reloads };
  return result;
}

describe("Codex same-session account switching", () => {
  it("reloads the same agent for a manual switch after preparing its home and env", async () => {
    const { service, store, paseo, notes, created, events, envs, reloads } = await harness();

    const summary = await service.setAgentAccount(paseo as never, AGENT, WORK);

    expect(summary).toEqual({ reopened: [AGENT], deferred: [], failed: [], continuedIn: null });
    expect(created).toHaveLength(0);
    expect(reloads).toEqual([AGENT]);
    expect(events).toEqual([`prepare:${join(root, "codex-work")}`, `env:${join(root, "codex-work")}`]);
    expect(envs).toEqual([{ INHERITED: "1", CODEX_HOME: join(root, "codex-work"), CODEX_SQLITE_HOME: "/shared/codex-sqlite" }]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(WORK);
    expect(notes.at(-1)).toMatchObject({ from: "personal", to: "work", outcome: "switched", continuedIn: null, toFamily: null });
  });

  it("fails over a limited Codex account without creating a Codex continuation", async () => {
    const { service, store, paseo, notes, created, sent, reloads } = await harness({ limit: true });

    await service.onTurnEnded(
      { agent: { id: AGENT, provider: "codex" }, turnId: "turn-1", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
      { paseo } as never,
    );

    expect(created).toHaveLength(0);
    expect(reloads).toEqual([AGENT]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(WORK);
    expect(notes.at(-1)).toMatchObject({ from: "personal", to: "work", outcome: "switched", continuedIn: null, toFamily: null });
    expect(sent).toHaveLength(1);
  });

  it("keeps the old session when reload fails and reports the pending switch once", async () => {
    const { service, store, paseo, notes, created, reloads } = await harness({ reload: "fails" });

    const summary = await service.setAgentAccount(paseo as never, AGENT, WORK);
    const state = await store.read();

    expect(created).toHaveLength(0);
    expect(reloads).toEqual([AGENT]);
    expect(summary).toMatchObject({ reopened: [], deferred: [], failed: [{ agentId: AGENT }] });
    expect(state.bindings[AGENT]?.accountId).toBe(WORK);
    expect(state.sessions[AGENT]?.accountId).toBe(MAIN);
    expect(notes.at(-1)).toMatchObject({ from: "personal", to: "work", outcome: "pending" });
  });
});
