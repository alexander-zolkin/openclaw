import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";

/** fs.listDir uses INVALID_REQUEST for host filesystem errors; only stable errno markers prove stale input. */
export function isMissingFolderError(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    /^(?:Error:\s+)?(?:ENOENT|ENOTDIR):/u.test(error.message)
  );
}

/** Owns folder validation and approved roots; the draft chooses replacement folders. */
export class DraftRestoredFolderValidation {
  private state: "none" | "checking" | "failed" = "none";
  private requestToken = 0;
  private approvedRoots: string[] = [];

  constructor(
    private readonly read: () => {
      gateway: ApplicationContext["gateway"]["snapshot"] | undefined;
      folder: string;
      selectedByUser: boolean;
      isAdmin: boolean;
      nodeId?: string;
    },
    private readonly callbacks: {
      onApprovedRootsChange: () => void;
      onVerified: (listing: FsListDirResult) => void;
      onMissing: () => void;
      onFailed: () => void;
    },
  ) {}

  knownWorkspaceRoots(workspace: string): string[] {
    return workspace ? [workspace, ...this.approvedRoots] : this.approvedRoots;
  }

  recordApprovedListing(listing: FsListDirResult) {
    if (this.read().isAdmin || this.read().nodeId) {
      return;
    }
    const roots = new Set(this.approvedRoots);
    roots.add(listing.path);
    if (listing.parent) {
      roots.add(listing.parent);
    }
    if (roots.size !== this.approvedRoots.length) {
      this.approvedRoots = [...roots];
      this.callbacks.onApprovedRootsChange();
    }
  }

  reset() {
    this.cancel();
    this.approvedRoots = [];
  }

  get loading(): boolean {
    return this.state === "checking";
  }

  get blocked(): boolean {
    return this.state !== "none";
  }

  cancel() {
    this.requestToken += 1;
    this.state = "none";
  }

  private restore() {
    this.state = "none";
    this.callbacks.onMissing();
  }

  validate(folder: string) {
    const source = this.read();
    const nodeId = source.nodeId;
    const snapshot = source.gateway;
    const client = snapshot?.client;
    if (snapshot?.phase !== "connected" || !client) {
      if (nodeId) {
        this.state = "failed";
        this.callbacks.onFailed();
      } else {
        this.restore();
      }
      return;
    }
    const requestId = ++this.requestToken;
    this.state = "checking";
    const isCurrent = () => {
      const current = this.read();
      return (
        requestId === this.requestToken &&
        (Boolean(nodeId) || !current.selectedByUser) &&
        current.folder === folder &&
        current.nodeId === nodeId &&
        current.gateway?.client === client &&
        current.gateway?.phase === "connected"
      );
    };
    void client
      .request<FsListDirResult>("fs.listDir", {
        ...(folder ? { path: folder } : {}),
        ...(nodeId ? { nodeId } : {}),
      })
      .then((result) => {
        if (!isCurrent()) {
          return;
        }
        this.recordApprovedListing(result);
        this.state = "none";
        this.callbacks.onVerified(result);
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return;
        }
        if (!nodeId && (!this.read().isAdmin || isMissingFolderError(error))) {
          this.restore();
          return;
        }
        this.state = "failed";
        this.callbacks.onFailed();
      });
  }
}
