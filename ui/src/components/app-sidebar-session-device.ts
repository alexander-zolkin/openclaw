import type { PresenceEntry } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

export type SidebarSessionActivityFilter =
  | "all"
  | "working"
  | "attention"
  | "unread"
  | "pinned"
  | "idle"
  | "system";

export type SidebarSessionDevice = { id: string; label: string; title: string };
type DeviceRow = Pick<
  SidebarRecentSession,
  "execNode" | "placementDeviceId" | "placementProviderId" | "placementProfileId"
>;

/** Execution location comes from the session owner; presence supplies only its display label. */
export function sidebarSessionDevice(
  row: DeviceRow,
  presence: readonly PresenceEntry[] = [],
): SidebarSessionDevice {
  const nodeId = row.placementDeviceId || row.execNode;
  if (nodeId) {
    const node = presence.find(
      (entry) =>
        entry.deviceId === nodeId && (entry.mode === "node" || entry.roles?.includes("node")),
    );
    const title = node?.host || nodeId;
    const label = /(?:^|[-\s])wsl(?:$|[-\s])/i.test(title)
      ? "PC · WSL"
      : /^win/i.test(node?.platform ?? "") || /windows/i.test(title)
        ? "PC · Windows"
        : /^[a-f\d-]{16,}$/i.test(title)
          ? `${t("chat.sidebar.deviceNode")} ${title.slice(0, 8)}`
          : title;
    return { id: `node:${nodeId}`, label, title };
  }
  if (row.placementProviderId || row.placementProfileId) {
    const title = row.placementProfileId || row.placementProviderId!;
    return {
      id: `cloud:${row.placementProviderId ?? ""}:${row.placementProfileId ?? ""}`,
      label: title,
      title,
    };
  }
  const label =
    presence.find((entry) => entry.mode === "gateway" && entry.reason === "self")?.host ||
    t("chat.sidebar.deviceGateway");
  return { id: "gateway", label, title: label };
}

export function sidebarSessionMatchesActivity(
  row: Pick<
    SidebarRecentSession,
    "hasActiveRun" | "runningChildCount" | "attention" | "unread" | "pinned" | "systemSession"
  >,
  filter: SidebarSessionActivityFilter,
): boolean {
  switch (filter) {
    case "working":
      return row.hasActiveRun || row.runningChildCount > 0;
    case "attention":
      return row.attention.kind !== "none";
    case "unread":
      return row.unread;
    case "pinned":
      return row.pinned;
    case "idle":
      return !row.hasActiveRun && row.runningChildCount === 0 && row.attention.kind === "none";
    case "system":
      return row.systemSession === true;
    default:
      return true;
  }
}

/** Keep navigation ancestors when a matching child lives on a different device. */
export function filterSidebarSessionRows(
  rows: readonly SidebarRecentSession[],
  device: string,
  activity: SidebarSessionActivityFilter,
  presence: readonly PresenceEntry[],
): SidebarRecentSession[] {
  if (device === "all" && activity === "all") return [...rows];
  return rows.flatMap((row) => {
    const children = filterSidebarSessionRows(row.children, device, activity, presence);
    const matches =
      (device === "all" || sidebarSessionDevice(row, presence).id === device) &&
      sidebarSessionMatchesActivity(row, activity);
    return matches || children.length ? [{ ...row, children }] : [];
  });
}

export const SIDEBAR_SESSION_ACTIVITY_OPTIONS = [
  { value: "all", labelKey: "chat.sidebar.viewAll" },
  { value: "working", labelKey: "chat.sidebar.viewWorking" },
  { value: "attention", labelKey: "chat.sidebar.viewAttention" },
  { value: "unread", labelKey: "sessionsView.unread" },
  { value: "pinned", labelKey: "sessionsView.pinned" },
  { value: "idle", labelKey: "chat.sidebar.viewIdle" },
  { value: "system", labelKey: "chat.sidebar.viewSystem" },
] as const;
