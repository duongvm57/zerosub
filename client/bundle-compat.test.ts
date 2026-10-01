import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as pluginSharedRuntime from "@getpaseo/plugin";
import * as pluginClientRuntime from "@getpaseo/plugin/client";
import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactQuery from "@tanstack/react-query";
import * as Zod from "zod";

// Paseo compiles plugin clients with these exact options and evaluates the
// result through `eval` under Hermes on Android. Hermes mis-initializes the
// prototype of class constructors created inside eval'd code, so any `class`
// that survives into the bundle crashes at `new` with
// "Cannot read property 'prototype' of undefined".
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HOST_EXTERNALS = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "@getpaseo/plugin/server/acp",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/client/react-native",
  "@tanstack/react-query",
  "react",
  "react/jsx-runtime",
  "react-native",
  "zod",
];

async function compileClientBundle(): Promise<string> {
  const result = await build({
    entryPoints: [path.join(pluginRoot, "index.client.tsx")],
    bundle: true,
    format: "cjs",
    write: false,
    platform: "neutral",
    target: "es2020",
    jsx: "automatic",
    supported: { "async-await": false },
    external: HOST_EXTERNALS,
    logLevel: "silent",
  });
  return result.outputFiles[0]!.text;
}

function stubComponent(): null {
  return null;
}

function runtimeRequire(name: string): unknown {
  if (name === "@getpaseo/plugin/client/ui") {
    return {
      SettingsGroup: stubComponent,
      SettingsSection: stubComponent,
      SettingsCard: stubComponent,
      SettingsRow: stubComponent,
      SettingsSwitch: stubComponent,
      SettingsSelect: stubComponent,
      SettingsInput: stubComponent,
      SettingsAction: stubComponent,
    };
  }
  if (name === "react") return React;
  if (name === "react/jsx-runtime") return ReactJsxRuntime;
  if (name === "react-native") {
    return {
      Text: stubComponent,
      View: stubComponent,
      Pressable: stubComponent,
      ActivityIndicator: stubComponent,
      ScrollView: stubComponent,
      FlatList: stubComponent,
      TextInput: stubComponent,
      Modal: stubComponent,
      StyleSheet: { create: (styles: unknown) => styles },
    };
  }
  if (name === "@getpaseo/plugin") return pluginSharedRuntime;
  if (name === "@getpaseo/plugin/client") {
    return { ...pluginClientRuntime, useSettings: () => null };
  }
  if (name === "@getpaseo/plugin/client/react-native") {
    return {
      Icon: stubComponent,
      Modal: stubComponent,
      ScrollView: stubComponent,
      FlatList: stubComponent,
      TextInput: stubComponent,
      copyText: async () => undefined,
      useRevealedText: () => "",
      useToast: () => ({ show() {}, error() {} }),
    };
  }
  if (name === "@tanstack/react-query") return ReactQuery;
  if (name === "zod") return Zod;
  throw new Error(`Module "${name}" is not available in plugin client code`);
}

describe("client bundle", () => {
  it("contains no class syntax (Hermes cannot construct eval'd classes)", async () => {
    const code = await compileClientBundle();
    expect(code).not.toMatch(/\bclass\b/);
  });

  it("evaluates through the host wrapper and runs setup", async () => {
    const code = await compileClientBundle();
    const wrapped = `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\n\nreturn module.exports;\n})`;
    const evaluate: (source: string) => unknown = globalThis.eval;
    const factory = evaluate(wrapped);
    expect(typeof factory).toBe("function");
    const exports = (factory as (req: typeof runtimeRequire) => unknown)(runtimeRequire);
    const setup = Reflect.get(exports as object, "default");
    expect(typeof setup).toBe("function");
    const registrations: string[] = [];
    const registration = () => ({ update() {}, remove() {} });
    const context = {
      rpc: async () => ({ agents: [], accounts: [], logins: [], switches: [] }),
      paseo: {
        agents: {
          list: async () => ({
            entries: [],
            pageInfo: { hasMore: false, nextCursor: null },
            subscription: { subscribe: () => ({ unsubscribe() {} }), unsubscribe() {} },
          }),
        },
      },
      openSettings() {},
      openSurface() {},
      openPanel() {},
      addSurface: () => (registrations.push("surface"), () => {}),
      addSidebarItem: () => (registrations.push("sidebar"), () => {}),
      addSettingsScreen: () => (registrations.push("settings"), () => {}),
      addWorkspacePanel: () => () => {},
      addCommandCenterItem: () => (registrations.push("command"), () => {}),
      addSlashCommand: () => (registrations.push("slash"), () => {}),
      addAttachmentSource: () => () => {},
      addTheme: () => () => {},
      addTimelineTransformer: () => () => {},
      addTimelineRenderer: () => (registrations.push("timeline"), () => {}),
      addComposerPill: registration,
      addHeaderButton: registration,
    };
    const cleanup = (setup as (ctx: unknown) => unknown)(context);
    expect(typeof cleanup).toBe("function");
    expect(registrations).toContain("surface");
    expect(registrations).toContain("settings");
    expect(registrations).toContain("timeline");
  });
});
