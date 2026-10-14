import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Sent after a switch or a reset, so it must read right for both. */
export const DEFAULT_CONTINUE_PROMPT =
  "You were interrupted by a usage limit; that has been sorted out. Continue exactly where you left off.";

export const DEFAULT_PING_MODELS = { claude: "haiku", codex: "gpt-5.6-luna" } as const;

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Move an agent to another account of the same provider when its account hits a usage limit. */
    autoSwitch: z.boolean().default(true),
    /** After an automatic switch, send a follow-up so the interrupted turn keeps going. */
    autoContinue: z.boolean().default(true),
    continuePrompt: z.string().trim().min(1).max(500).default(DEFAULT_CONTINUE_PROMPT),
    /** New agents start on the account with the most headroom instead of the default. */
    balanceNewAgents: z.boolean().default(false),
    /** Start an idle five-hour quota window with one short message on selected accounts. */
    autoPing: z.boolean().default(false),
    pingAccountIds: z.array(z.string().min(1)).default([]),
    claudePingModel: z.string().trim().min(1).max(200).default(DEFAULT_PING_MODELS.claude),
    codexPingModel: z.string().trim().min(1).max(200).default(DEFAULT_PING_MODELS.codex),
    /** When every account of a provider is at its limit, spend a banked reset instead of stopping. */
    autoRedeem: z.boolean().default(false),
    /**
     * When every account of a provider is at its limit, carry the chat on in a new agent on the
     * other provider (Claude ↔ ChatGPT), in a mode no more permissive than the original's.
     */
    forkOtherProvider: z.boolean().default(false),
    /** Show the account pill in the composer of Claude and Codex agents. */
    showComposerPill: z.boolean().default(true),
  }),
});

export type Preferences = z.output<typeof preferences.schema>;
