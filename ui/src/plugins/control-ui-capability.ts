import type { PluginControlUiDiagnostic } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import type {
  ControlUiAction,
  ControlUiAccessory,
  ControlUiDisposer,
  ControlUiHost,
  ControlUiNavigationItem,
  ControlUiPage,
  ControlUiPanel,
  ControlUiReplacement,
  ControlUiSurface,
  ControlUiUserMessageEffect,
  ControlUiWidget,
} from "../../../src/plugin-sdk/control-ui.js";

export type ControlUiRegistration<T> = {
  key: `${string}/${string}`;
  pluginId: string;
  value: T;
  host: ControlUiHost;
  signal: AbortSignal;
};

export type ControlUiContributions = {
  pages: ControlUiPage;
  navigation: ControlUiNavigationItem;
  panels: ControlUiPanel;
  actions: ControlUiAction;
  accessories: ControlUiAccessory;
  userMessageEffects: ControlUiUserMessageEffect;
  widgets: ControlUiWidget;
  replacements: ControlUiReplacement;
};

// Application consumers use the registry contract; construction and activation
// ownership stay in the runtime without a dependency back through app context.
export type ControlUiPluginCapability = {
  readonly errors: readonly PluginControlUiDiagnostic[];
  readonly hasPlugins: boolean;
  readonly canReload: boolean;
  isLoading: (pluginId: string) => boolean;
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
  subscribe: (listener: () => void) => ControlUiDisposer;
  registrations: <K extends keyof ControlUiContributions>(
    kind: K,
  ) => ControlUiRegistration<ControlUiContributions[K]>[];
  selectedReplacement: (
    surface: ControlUiSurface,
  ) => ControlUiRegistration<ControlUiReplacement> | undefined;
  selectReplacement: (surface: ControlUiSurface, key: string | null) => void;
  /** Capture current message-effect registrations for one newly committed row. */
  captureUserMessageEffects: (params: {
    sessionKey: string;
    agentId: string;
    messageId: string;
    composerElement?: HTMLTextAreaElement;
  }) => ((element: HTMLElement) => boolean) | undefined;
  reportError: (pluginId: string, error: unknown) => void;
};
