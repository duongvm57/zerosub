import { useHosts, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { FAMILY_LABEL } from "../shared/model";
import { DEFAULT_CONTINUE_PROMPT, preferences, type Preferences } from "../shared/preferences";
import { useStore, type ZeroSubStore } from "./store";

/** Settings → Plugins → zerosub. Accounts themselves live in the sidebar surface. */
export function PreferencesScreen({ theme, host, store, onOpenAccounts }: PluginSurfaceProps & { store: ZeroSubStore; onOpenAccounts(): void }) {
  const settings = useSettings(preferences);
  const { state, error } = useStore(store);
  const multiHost = useHosts().length > 1;
  const [prompt, setPrompt] = useState<string | null>(null);
  const [pingModels, setPingModels] = useState<Partial<Pick<Preferences, "claudePingModel" | "codexPingModel">>>({});
  const muted = { color: theme.colors.foregroundMuted };
  if (settings.status === "loading") return <Text style={muted}>Loading…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Preferences">
        <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={() => void settings.reload()} />
        {settings.status === "invalid" ? (
          <SettingsAction label="Restore defaults" actionLabel="Reset" onPress={() => void settings.reset()} />
        ) : null}
      </SettingsSection>
    );
  }
  const save = (patch: Partial<Preferences>) =>
    settings.save({ ...settings.values, ...patch }, settings.revision);
  return (
    <>
      {multiHost ? (
        <Text style={muted}>These apply to agents on {host.label}. Each host keeps its own accounts and preferences.</Text>
      ) : null}
      <SettingsSection title="Accounts">
        <SettingsCard>
          <SettingsAction
            label="Add, remove, and choose default accounts"
            actionLabel="Open accounts"
            onPress={onOpenAccounts}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Start quota windows">
        <SettingsCard>
          <SettingsSwitch
            label="Ping idle accounts automatically"
            hint="Sends “Reply OK.” when a selected account's five-hour window is idle. Uses a small amount of quota. Off by default; no accounts are selected initially."
            value={settings.values.autoPing}
            disabled={settings.saving}
            onValueChange={(autoPing) => save({ autoPing })}
          />
          {(["claudePingModel", "codexPingModel"] as const).map((key) => (
            <SettingsInput
              key={key}
              label={key === "claudePingModel" ? "Claude ping model" : "ChatGPT ping model"}
              initialValue={settings.values[key]}
              onChangeText={(value) => setPingModels((current) => ({ ...current, [key]: value }))}
              disabled={settings.saving}
            />
          ))}
          <SettingsAction
            label="Save ping models"
            actionLabel="Save"
            disabled={settings.saving || Object.keys(pingModels).length === 0 ||
              Object.values(pingModels).some((model) => !model.trim() || model.trim().length > 200)}
            onPress={() => {
              const patch = Object.fromEntries(Object.entries(pingModels).map(([key, model]) => [key, model.trim()]));
              void save(patch).then((saved) => {
                if (saved !== false) setPingModels({});
              }, () => undefined);
            }}
          />
          <Text style={muted}>Choose accounts on {host.label}. Disabled or signed-out accounts are skipped.</Text>
          {state ? state.accounts.map((account) => (
            <SettingsSwitch
              key={account.id}
              label={`${FAMILY_LABEL[account.family]} · ${account.label}`}
              hint={account.email ?? undefined}
              value={settings.values.pingAccountIds.includes(account.id)}
              disabled={settings.saving}
              onValueChange={(selected) => save({ pingAccountIds: selected
                ? [...new Set([...settings.values.pingAccountIds, account.id])]
                : settings.values.pingAccountIds.filter((id) => id !== account.id) })}
            />
          )) : <Text style={muted}>{error ?? "Loading accounts…"}</Text>}
          {state?.accounts.length === 0 ? <Text style={muted}>Add an account to select it for pings.</Text> : null}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Automatic switching">
        <SettingsCard>
          <SettingsSwitch
            label="Switch accounts when one hits its limit"
            hint="The agent moves to the account with the most room left."
            value={settings.values.autoSwitch}
            disabled={settings.saving}
            onValueChange={(autoSwitch) => save({ autoSwitch })}
          />
          <SettingsSwitch
            label="Keep going after a switch"
            hint="Sends the follow-up below so the interrupted task continues."
            value={settings.values.autoContinue}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(autoContinue) => save({ autoContinue })}
          />
          <SettingsInput
            label="Follow-up message"
            initialValue={settings.values.continuePrompt}
            onChangeText={setPrompt}
            disabled={settings.saving || !settings.values.autoContinue}
            error={settings.saveError}
          />
          <SettingsAction
            label="Save the follow-up message"
            actionLabel="Save"
            disabled={settings.saving || prompt === null || !prompt.trim()}
            onPress={() => {
              if (prompt?.trim()) save({ continuePrompt: prompt.trim() });
            }}
          />
          <SettingsAction
            label="Restore the default follow-up"
            actionLabel="Restore"
            disabled={settings.saving || settings.values.continuePrompt === DEFAULT_CONTINUE_PROMPT}
            onPress={() => save({ continuePrompt: DEFAULT_CONTINUE_PROMPT })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="New agents and composer">
        <SettingsCard>
          <SettingsSwitch
            label="Spread new agents across accounts"
            hint="New agents start on the account with the most room instead of the default."
            value={settings.values.balanceNewAgents}
            disabled={settings.saving}
            onValueChange={(balanceNewAgents) => save({ balanceNewAgents })}
          />
          <SettingsSwitch
            label="Use banked resets when every account is out"
            hint="Spends one of the account's banked resets instead of stopping. Off unless you turn it on: resets are scarce."
            value={settings.values.autoRedeem}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(autoRedeem) => save({ autoRedeem })}
          />
          <SettingsSwitch
            label="When every account is out, fork the chat to the other provider"
            hint="A stopped Claude chat carries on in a new ChatGPT agent, or the other way round, with the conversation so far and no more permissions than the original. The original stays as it was."
            value={settings.values.forkOtherProvider}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(forkOtherProvider) => save({ forkOtherProvider })}
          />
          <SettingsSwitch
            label="Show the account pill in the composer"
            hint="Appears on Claude and Codex agents once a provider has two or more accounts."
            value={settings.values.showComposerPill}
            disabled={settings.saving}
            onValueChange={(showComposerPill) => save({ showComposerPill })}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
