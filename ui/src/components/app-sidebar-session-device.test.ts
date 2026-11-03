import { afterEach, describe, expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { PresenceEntry } from "../api/types.ts";
import { projectSidebarAgentSessionRows } from "./app-sidebar-agent-session-rows.ts";
import {
  filterSidebarSessionRows,
  sidebarSessionDevice,
  sidebarSessionMatchesActivity,
} from "./app-sidebar-session-device.ts";
import { projectSidebarSession } from "./app-sidebar-session-navigation.test-support.ts";
import {
  loadStoredSidebarSessionsGrouping,
  storeSidebarSessionsGrouping,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";

const presence: PresenceEntry[] = [
  { mode: "gateway", reason: "self", host: "N100", ts: 1 },
  { mode: "node", deviceId: "wsl", host: "Desktop-WSL", platform: "linux", ts: 1 },
  { mode: "node", deviceId: "windows", host: "Desktop-Windows", platform: "windows", ts: 1 },
];
const row = (overrides: Partial<SidebarRecentSession> = {}): SidebarRecentSession => ({
  key: "agent:main:test",
  label: "Test",
  renameValue: "Test",
  active: false,
  visuallyActive: false,
  hasActiveRun: false,
  modelSelectionLocked: false,
  pinned: false,
  pinnable: true,
  cloudWorkerStopAction: null,
  hasAutomation: false,
  unread: false,
  attention: { kind: "none" },
  childSessionKeys: [],
  children: [],
  isChild: false,
  loadingChildren: false,
  containsActiveDescendant: false,
  runningChildCount: 0,
  failedChildCount: 0,
  ...overrides,
});

afterEach(() => localStorage.clear());

describe("sidebar execution devices", () => {
  it("uses exact execution identity and existing presence labels", () => {
    expect(sidebarSessionDevice(row(), presence)).toEqual({
      id: "gateway",
      label: "N100",
      title: "N100",
    });
    expect(sidebarSessionDevice(row({ execNode: "wsl" }), presence)).toEqual({
      id: "node:wsl",
      label: "PC · WSL",
      title: "Desktop-WSL",
    });
    expect(sidebarSessionDevice(row({ execNode: "windows" }), presence).label).toBe("PC · Windows");
    expect(sidebarSessionDevice(row({ execNode: "unpaired-offline" }), presence).id).toBe(
      "node:unpaired-offline",
    );
  });

  it("keeps authoritative placement ahead of a former exec binding", () => {
    expect(
      sidebarSessionDevice(row({ execNode: "wsl", placementDeviceId: "windows" }), presence).id,
    ).toBe("node:windows");
    expect(
      sidebarSessionDevice(
        row({ placementProviderId: "cloud", placementProfileId: "build" }),
        presence,
      ).id,
    ).toBe("cloud:cloud:build");
  });

  it("filters factual row state and retains the navigation ancestor of a matching child", () => {
    const child = row({ key: "child", execNode: "wsl", unread: true, isChild: true });
    const parent = row({ key: "parent", children: [child], childSessionKeys: ["child"] });
    const windows = row({ key: "windows", execNode: "windows", unread: true });
    const filtered = filterSidebarSessionRows([parent, windows], "node:wsl", "unread", presence);
    expect(filtered.map((entry) => entry.key)).toEqual(["parent"]);
    expect(filtered[0]?.children.map((entry) => entry.key)).toEqual(["child"]);
    expect(parent.children).toEqual([child]);
  });

  it("does not infer attention or process residency from a completed session", () => {
    const idle = row({ status: "completed" });
    expect(sidebarSessionMatchesActivity(idle, "idle")).toBe(true);
    expect(sidebarSessionMatchesActivity(idle, "attention")).toBe(false);
    expect(sidebarSessionMatchesActivity(row({ hasActiveRun: true }), "working")).toBe(true);
    expect(sidebarSessionMatchesActivity(row({ runningChildCount: 1 }), "idle")).toBe(false);
    expect(sidebarSessionMatchesActivity(row({ unread: true }), "unread")).toBe(true);
    expect(sidebarSessionMatchesActivity(row({ pinned: true }), "pinned")).toBe(true);
    expect(sidebarSessionMatchesActivity(row({ systemSession: true }), "system")).toBe(true);
  });
});

describe("flat sidebar preference migration", () => {
  const key = "openclaw:sidebar:sessions:grouping";

  it("starts with a flat list and migrates the previous automatic category split once", () => {
    expect(loadStoredSidebarSessionsGrouping()).toBe("none");
    localStorage.clear();
    localStorage.setItem(key, "category");
    expect(loadStoredSidebarSessionsGrouping()).toBe("none");
    expect(localStorage.getItem(key)).toBe("none");
    storeSidebarSessionsGrouping("category");
    expect(loadStoredSidebarSessionsGrouping()).toBe("category");
  });

  it("retains an explicit calendar or project grouping", () => {
    localStorage.setItem(key, "date");
    expect(loadStoredSidebarSessionsGrouping()).toBe("date");
    storeSidebarSessionsGrouping("project");
    expect(loadStoredSidebarSessionsGrouping()).toBe("project");
  });
});

describe("System view through the sidebar projection owner", () => {
  it("keeps system roots only when the view or existing toggle requests them", () => {
    const rows: GatewaySessionRow[] = [
      { key: "agent:main:human", kind: "direct", updatedAt: 2 },
      {
        key: "agent:main:internal",
        kind: "direct",
        updatedAt: 1,
        createdActor: { type: "system", id: "internal" },
      },
    ];
    const result = { sessions: rows, count: rows.length } as SessionsListResult;
    type Host = Parameters<typeof projectSidebarAgentSessionRows>[0]["host"];
    const host = {
      sessionDataContext: {
        agents: { state: { agentsList: { defaultId: "main", agents: [{ id: "main" }] } } },
        gateway: { snapshot: { hello: null } },
        sessions: { deletionState: () => undefined, archiveVisibility: () => undefined },
      },
      sessionData: {
        sessionsAgentId: "main",
        sessionsResult: result,
        sessionResultsByAgent: {},
        childSessionRowsByParent: {},
        loadedChildSessionKeys: new Set(),
        loadingChildSessionKeys: new Set(),
        childSessionErrorsByParent: new Map(),
      },
      visibleSessionCatalogs: () => [],
      selectedAgentMainSessionKey: () => "agent:main:main",
      sessionsShowCron: false,
      sessionsShowSystem: false,
      sessionsStatusFilter: "active",
      sessionInvolvingMeFilterActive: false,
      sessionActivityFilter: "all",
    } as unknown as Host;
    const project = () =>
      projectSidebarAgentSessionRows({
        host,
        selected: "main",
        agentIds: ["main"],
        result,
        navigationState: {
          routeSessionKey: "agent:main:missing",
          selectedAgentId: "main",
          activeRowKey: null,
          visibleSessionRows: rows,
          toSidebarSession: (entry) => projectSidebarSession(entry),
        },
        compareSessions: (a, b) => a.key.localeCompare(b.key),
        resolveAttention: () => ({ kind: "none" }),
      }).map((entry) => entry.key);
    expect(project()).toEqual(["agent:main:human"]);
    Object.assign(host, { sessionActivityFilter: "system" });
    expect(project()).toEqual(["agent:main:human", "agent:main:internal"]);
    Object.assign(host, { sessionActivityFilter: "all", sessionsShowSystem: true });
    expect(project()).toEqual(["agent:main:human", "agent:main:internal"]);
  });
});
