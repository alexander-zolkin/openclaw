import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { projectDevicePlacements } from "./device-placement.ts";
import { buildSelectedSessionCreateParams } from "./draft-create-params.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { resolveDraftSessionPlacement } from "./draft-session-placement.ts";
import { resolveWhereChip } from "./where-chip.ts";

const homes = { desktop: "C:\\Users\\demo", wsl: "/home/demo" };
function setup() {
  const f = createRepositoryFixture();
  f.request.mockImplementation(async (method, params) => {
    if (method === "fs.listDir") {
      const p = params as { nodeId?: keyof typeof homes; path?: string };
      const home = p.nodeId ? homes[p.nodeId] : "/workspace";
      return { path: p.path || home, home, entries: [] };
    }
    return { repositoryStatus: "not_git", branches: [] };
  });
  Object.assign(f.gateway, {
    environments: [
      {
        id: "node:desktop",
        type: "node",
        status: "available",
        platform: "windows",
        sessionHost: false,
        invocableCommands: ["system.run"],
      },
      {
        id: "node:wsl",
        type: "node",
        status: "available",
        platform: "linux",
        sessionHost: false,
        invocableCommands: ["system.run"],
      },
    ],
  });
  f.state.setAgentsHydrated(true);
  f.state.adoptAgentDefaults();
  f.request.mockClear();
  return f;
}
afterEach(() => vi.restoreAllMocks());

describe("standard New Chat in an existing device folder", () => {
  it.each(["desktop", "wsl"] as const)(
    "uses %s home without Git, a worker slot, or Gateway filesystem fallback",
    async (id) => {
      const f = setup();
      f.state.selectDevice(id);
      await vi.waitFor(() => expect(f.state.folder).toBe(homes[id]));
      expect(f.request).toHaveBeenCalledWith("fs.listDir", { nodeId: id });
      expect(f.request.mock.calls.some(([method]) => method === "worktrees.branches")).toBe(false);
      expect(f.state.workspacePath()).toBe("/workspace");
      expect(f.state.remotePlacement).toBe(false);
      expect(f.state.worktree).toBe(false);
      expect(f.state.folderSubmissionBlocked()).toBe(false);
      expect(resolveDraftSessionPlacement({ sessionKey: "", target: null }, f.state)).toBeNull();
      const model = "openai/test@openai:account@example.test";
      f.state.modelControl.selected = model;
      const attachments: NonNullable<SessionCreateParams["attachments"]> = [
        { type: "image", mimeType: "image/png", content: "synthetic" },
      ];
      const params = buildSelectedSessionCreateParams(f.state, {
        message: "Who are you?",
        visibility: "normal",
        attachments,
        permissionMode: "guarded",
      });
      expect(params).toMatchObject({
        agentId: "main",
        message: "Who are you?",
        model,
        execNode: id,
        cwd: homes[id],
        attachments,
        permissionMode: "guarded",
      });
      expect(params).not.toHaveProperty("worktree");
      expect(params).not.toHaveProperty("projectId");
      expect(params).not.toHaveProperty("titleSource");
      f.state.modelControl.reset();
    },
  );

  it("browses and remembers only folders belonging to the selected node", async () => {
    const f = setup();
    f.state.selectDevice("wsl");
    await vi.waitFor(() => expect(f.state.folder).toBe(homes.wsl));
    f.browser.selectGatewayBrowser("/home/demo/project");
    await vi.waitFor(() => expect(f.browser.browser.loading).toBe(false));
    expect(f.request).toHaveBeenCalledWith("fs.listDir", {
      nodeId: "wsl",
      path: "/home/demo/project",
    });
    expect(f.browser.browserProjectPath).toBeNull();
    expect(f.request.mock.calls.some(([method]) => method === "worktrees.branches")).toBe(false);
    expect(
      f.browser
        .resolveProjectRecents({
          sessions: [
            { execNode: "desktop", execCwd: "C:\\Projects\\other" },
            { execNode: "wsl", execCwd: "/home/demo/project" },
          ],
          workspace: homes.wsl,
          workspaceRoots: [],
          isAdmin: true,
        })
        .map((r) => (r.kind === "folder" ? r.folder : "unexpected")),
    ).toEqual(["/home/demo/project"]);
    f.state.modelControl.reset();
  });

  it("does not let a late Windows response replace a later WSL selection", async () => {
    const f = setup();
    const pending = createDeferred<unknown>();
    f.request.mockImplementation(async (method, params) => {
      if (method === "fs.listDir" && (params as { nodeId?: string }).nodeId === "desktop")
        return pending.promise;
      return { path: homes.wsl, home: homes.wsl, entries: [] };
    });
    f.state.selectDevice("desktop");
    f.state.selectDevice("wsl");
    await vi.waitFor(() => expect(f.state.folder).toBe(homes.wsl));
    pending.resolve({ path: homes.desktop, home: homes.desktop, entries: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.state.folder).toBe(homes.wsl);
    expect(f.state.deviceId).toBe("wsl");
    f.state.modelControl.reset();
  });

  it("keeps unavailable device home blocked instead of silently using Gateway workspace", async () => {
    const f = setup();
    f.request.mockRejectedValue(new Error("Device unavailable"));
    f.state.selectDevice("desktop");
    await vi.waitFor(() => expect(f.state.folderLoading).toBe(false));
    expect(f.state.folder).toBe("");
    expect(f.state.folderSubmissionBlocked()).toBe(true);
    f.state.modelControl.reset();
  });

  it("retains a manually selected node path while disconnected instead of restoring Gateway cwd", async () => {
    const f = setup();
    f.state.selectDevice("desktop");
    await vi.waitFor(() => expect(f.state.folder).toBe(homes.desktop));
    Object.assign(f.context.gateway.snapshot, { phase: "connecting" });
    f.request.mockClear();
    f.state.applyFolder("C:\\Projects\\offline");
    expect(f.state.folder).toBe("C:\\Projects\\offline");
    expect(f.state.folderSubmissionBlocked()).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
    f.state.modelControl.reset();
  });

  it("retains an explicit managed worktree and can switch back to the device folder", async () => {
    const f = setup();
    f.state.selectDevice("wsl");
    await vi.waitFor(() => expect(f.state.folder).toBe(homes.wsl));
    f.state.selectWorktree(true);
    expect(f.state.directDevice).toBe(false);
    expect(f.state.remotePlacement).toBe(true);
    expect(resolveDraftSessionPlacement({ sessionKey: "", target: null }, f.state)).toEqual({
      kind: "device",
      deviceId: "wsl",
    });
    expect(f.state.worktree).toBe(true);
    expect(f.state.folder).toBe("/workspace");
    f.state.selectWorktree(false);
    await vi.waitFor(() => expect(f.state.folder).toBe(homes.wsl));
    expect(f.state.directDevice).toBe(true);
    expect(f.state.worktree).toBe(false);
    f.state.modelControl.reset();
  });

  it("ignores legacy forced-worktree Gateway folder preferences for a plain device start", async () => {
    const f = setup();
    f.readPreference.mockReturnValue({
      where: { kind: "device", id: "desktop" },
      folder: "/workspace",
      worktree: true,
    });
    f.state.adoptAgentDefaults();
    f.state.restorePreferenceSelections();
    await vi.waitFor(() => expect(f.state.folder).toBe(homes.desktop));
    expect(
      f.request.mock.calls
        .filter(([method]) => method === "fs.listDir")
        .every(([, params]) => (params as { nodeId?: string }).nodeId === "desktop"),
    ).toBe(true);
    expect(f.state.worktree).toBe(false);
    f.state.modelControl.reset();
  });

  it("preserves a restored local worktree choice while Git discovery is still pending", () => {
    const f = createRepositoryFixture({ workspaceGit: true });
    const pending = createDeferred<unknown>();
    f.request.mockReturnValue(pending.promise);
    f.readPreference.mockReturnValue({ where: { kind: "local" }, worktree: true });
    f.state.adoptAgentDefaults();
    expect(f.state.preferenceSelection().worktree).toBe(true);
    f.state.modelControl.reset();
  });

  it("keeps non-admin device starts managed and does not rewrite saved folder intent after role loss", async () => {
    const f = setup();
    Object.assign(f.context.gateway.snapshot.hello!.auth!, {
      scopes: ["operator.read", "operator.write"],
    });
    Object.assign(f.gateway, {
      environments: [
        {
          id: "node:desktop",
          type: "node",
          status: "available",
          sessionHost: true,
          workerSlots: { total: 1, available: 1 },
          invocableCommands: ["system.run"],
        },
      ],
    });
    f.state.selectDevice("desktop");
    expect(f.state.directDevice).toBe(false);
    expect(resolveDraftSessionPlacement({ sessionKey: "", target: null }, f.state)).toEqual({
      kind: "device",
      deviceId: "desktop",
    });
    f.readPreference.mockReturnValue({
      where: { kind: "device", id: "desktop" },
      folder: "/workspace",
      worktree: true,
    });
    f.state.resetDraft();
    f.state.adoptAgentDefaults();
    f.state.restorePreferenceSelections();
    expect(f.state.directDevice).toBe(false);
    expect(resolveDraftSessionPlacement({ sessionKey: "", target: null }, f.state)).toEqual({
      kind: "device",
      deviceId: "desktop",
    });
    expect(
      f.request.mock.calls.some(
        ([method, params]) =>
          method === "fs.listDir" && Boolean((params as { nodeId?: string })?.nodeId),
      ),
    ).toBe(false);
    f.state.modelControl.reset();
    const saved = setup();
    saved.state.selectDevice("desktop");
    await vi.waitFor(() => expect(saved.state.folder).toBe(homes.desktop));
    Object.assign(saved.context.gateway.snapshot.hello!.auth!, {
      scopes: ["operator.read", "operator.write"],
    });
    expect(saved.state.directDevice).toBe(true);
    expect(resolveDraftSessionPlacement({ sessionKey: "", target: null }, saved.state)).toBeNull();
    expect(
      buildSelectedSessionCreateParams(saved.state, { message: "continue", visibility: "normal" }),
    ).toMatchObject({ execNode: "desktop", cwd: homes.desktop });
    saved.state.modelControl.reset();
  });

  it("keeps the picker disabled when its shared device catalog is refreshing", () => {
    const reason = "Device catalog is refreshing";
    const state = resolveWhereChip({
      environments: [
        {
          id: "node:desktop",
          type: "node",
          status: "available",
          sessionHost: false,
          invocableCommands: ["system.run"],
        },
      ],
      cloudProfiles: [],
      cloudProfileId: "",
      deviceId: "desktop",
      directDevicePlacement: {
        requiredNodeCommands: ["system.run"],
        consumesWorkerSlot: false,
        sessionHost: false,
      },
      directDeviceDisabledReason: reason,
    });
    expect(state.devices[0]).toMatchObject({ selectable: false, disabledReason: reason });
  });

  it("checks shell availability without requiring worker capacity or native exec-server", () => {
    const requirement = {
      requiredNodeCommands: ["system.run"],
      consumesWorkerSlot: false,
      sessionHost: false,
    };
    const environment = {
      id: "node:desktop",
      type: "node" as const,
      status: "available" as const,
      sessionHost: false,
      invocableCommands: ["system.run"],
      workerSlots: { total: 1, available: 0 },
    };
    expect(projectDevicePlacements([environment], requirement)[0]).toMatchObject({
      selectable: true,
    });
    expect(
      projectDevicePlacements([{ ...environment, invocableCommands: [] }], requirement)[0]
        ?.selectable,
    ).toBe(false);
  });
});
