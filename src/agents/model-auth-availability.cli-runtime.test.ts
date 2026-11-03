import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import { routeResolverFactory } from "./model-auth-availability.test-support.js";

const provider = "fixture-cli";
const pluginId = "fixture-native-login";

// Supply only registered runtime metadata; authentication and order policy stay real.
vi.mock("../plugins/cli-backends.runtime.js", () => ({
  resolveRuntimeCliBackends: () => [
    {
      id: "fixture-cli",
      modelProvider: "fixture-cloud",
      pluginId: "fixture-native-login",
    },
  ],
}));

function resolver(
  options: {
    config?: OpenClawConfig;
    modes?: PreparedAgentCredentialModes;
    store?: AuthProfileStore;
    registered?: boolean;
    authAlias?: boolean;
  } = {},
) {
  return createModelAuthAvailabilityResolver({
    cfg: options.config ?? {},
    env: {},
    authStore: options.store ?? { version: 1, profiles: {} },
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins:
        options.registered === false
          ? []
          : [
              {
                id: pluginId,
                providers: [provider],
                cliBackends: [provider],
                syntheticAuthRefs: [provider],
                ...(options.authAlias
                  ? { providerAuthAliases: { [provider]: "fixture-cloud" } }
                  : {}),
              },
            ],
    }),
    syntheticAuthProviderRefs: [provider],
    preparedRuntimeAuthModes: options.modes ?? {
      [provider]: { source: "native", mode: "oauth" },
    },
    preparedSyntheticAuthComplete: true,
    routeResolverFactory: routeResolverFactory(null),
  });
}

describe("registered CLI native login readiness", () => {
  it("admits the exact native runtime without authorizing a provider bearer request", () => {
    const auth = resolver();
    expect(auth.evaluateRuntimeModelAuth(provider, { runtimeId: provider })).toMatchObject({
      availability: true,
      availabilityAuthoritative: true,
      selectedAuthMode: "oauth",
      evidence: "runtime",
      runtimeAuth: { id: provider, source: "native" },
    });
    expect(auth.evaluateModelAuth(provider).availability).not.toBe(true);
    expect(
      auth.evaluateRuntimeModelAuth(provider, { runtimeId: "openclaw" }).availability,
    ).not.toBe(true);
    expect(auth.evaluateRuntimeModelAuth("fixture-cloud", { runtimeId: provider })).toMatchObject({
      availability: true,
      runtimeAuth: { id: provider, source: "native" },
    });
  });

  it.each([
    { label: "unregistered runtime", registered: false },
    { label: "missing native login", modes: {} },
    {
      label: "another runtime's login",
      modes: {
        "other-cli": { source: "native", mode: "oauth" },
      } as const,
    },
    {
      label: "disabled owner",
      config: {
        plugins: {
          entries: {
            [pluginId]: { enabled: false },
          },
        },
      },
    },
    { label: "denied owner", config: { plugins: { deny: [pluginId] } } },
    { label: "excluded owner", config: { plugins: { allow: ["another-plugin"] } } },
  ])("does not admit $label", (options) => {
    expect(
      resolver(options).evaluateRuntimeModelAuth(provider, { runtimeId: provider }).availability,
    ).not.toBe(true);
  });

  it.each(["pinnedProfileId", "preferredProfileId", "requiredProfileId"] as const)(
    "does not replace an unavailable account selected by %s",
    (selection) => {
      const auth = resolver();
      expect(
        auth.evaluateRuntimeModelAuth(provider, {
          runtimeId: provider,
          [selection]: "fixture-cli:missing",
        }).availability,
      ).not.toBe(true);
    },
  );

  it.each(["pinnedProfileId", "preferredProfileId"] as const)(
    "does not replace a foreign account selected by %s",
    (selection) => {
      const auth = resolver({
        store: {
          version: 1,
          profiles: {
            "foreign:account": { type: "api_key", provider: "foreign", key: "fixture-key" },
          },
        },
      });
      expect(
        auth.evaluateRuntimeModelAuth(provider, {
          runtimeId: provider,
          [selection]: "foreign:account",
        }).availability,
      ).not.toBe(true);
    },
  );

  it.each(["config", "store"] as const)("respects an explicit empty %s account order", (source) => {
    const auth = resolver(
      source === "config"
        ? { config: { auth: { order: { [provider]: [] } } } }
        : { store: { version: 1, profiles: {}, order: { [provider]: [] } } },
    );
    expect(auth.evaluateRuntimeModelAuth(provider, { runtimeId: provider }).availability).not.toBe(
      true,
    );
  });

  it.each([
    { source: "config", key: "Fixture-CLI", authAlias: false, modelProvider: provider },
    { source: "store", key: "Fixture-CLI", authAlias: false, modelProvider: provider },
    { source: "config", key: "Fixture-Cloud", authAlias: true, modelProvider: provider },
    { source: "store", key: "Fixture-Cloud", authAlias: true, modelProvider: provider },
    { source: "config", key: "Fixture-CLI", authAlias: false, modelProvider: "fixture-cloud" },
    { source: "store", key: "Fixture-CLI", authAlias: false, modelProvider: "fixture-cloud" },
  ])(
    "respects $source order $key for $modelProvider",
    ({ source, key, authAlias, modelProvider }) => {
      const auth = resolver({
        authAlias,
        ...(source === "config"
          ? { config: { auth: { order: { [key]: [] } } } }
          : { store: { version: 1, profiles: {}, order: { [key]: [] } } }),
      });
      expect(
        auth.evaluateRuntimeModelAuth(modelProvider, { runtimeId: provider }).availability,
      ).not.toBe(true);
    },
  );

  it("does not borrow the login for another model provider", () => {
    expect(
      resolver().evaluateRuntimeModelAuth("foreign", { runtimeId: provider }).availability,
    ).not.toBe(true);
  });

  it("does not substitute a provider bearer for an empty native runtime account order", () => {
    const auth = resolver({
      config: {
        auth: { order: { [provider]: [] } },
        models: {
          providers: {
            "fixture-cloud": {
              api: "openai-completions",
              baseUrl: "https://fixture.invalid/v1",
              apiKey: "fixture-provider-bearer",
              models: [],
            },
          },
        },
      },
    });
    expect(auth.evaluateModelAuth("fixture-cloud").availability).toBe(true);
    expect(
      auth.evaluateRuntimeModelAuth("fixture-cloud", { runtimeId: provider }).availability,
    ).not.toBe(true);
  });
});
