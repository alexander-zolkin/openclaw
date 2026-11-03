import { readChatThreadMessageIdentity } from "../chat-thread-items.ts";
import type { buildCachedChatItems } from "../chat-thread.ts";
import { assistantGroupCanOwnActiveRunStatus } from "../chat-thread.ts";

type PendingUserMessageEntry = {
  key: string;
  effect?: (element: HTMLElement) => boolean;
  element?: HTMLElement;
};

// The committed transcript owns arrivals; mounting a virtual row is not an arrival.
export class ChatMessageEntryAnimations {
  private input: ReturnType<typeof buildCachedChatItems> | null = null;
  private projected: ReadonlyMap<string, string | null> = new Map();
  private committed: ReadonlyMap<string, string | null> = new Map();
  private userSubmissionKeys: ReadonlySet<string> = new Set();
  private readonly refs = new Map<string, (element?: Element) => void>();
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, PendingUserMessageEntry>();
  private readonly elements = new Map<string, HTMLElement>();
  private readonly active = new Map<HTMLElement, () => void>();
  private enabled = false;

  constructor(
    private readonly captureUserMessageEffect?: (
      messageId: string,
    ) => ((element: HTMLElement) => boolean) | undefined,
  ) {}

  get projectedKeys(): ReadonlyMap<string, string | null> {
    return this.projected;
  }

  project(items: ReturnType<typeof buildCachedChatItems>): ReadonlyMap<string, string | null> {
    // Live text is patched in place. Keys change with structural identity,
    // so token paints do not need another history walk.
    if (this.input === items) {
      return this.projected;
    }
    const entries = new Map<string, string | null>();
    const userSubmissionKeys = new Set<string>();
    // A reply can fill the viewport before its first paint, or finalize during
    // arrival. Fading/translating that asynchronous body hides or snaps the text.
    // Only prompts have a stable submission identity throughout their arrival.
    // Other rows still anchor the order so a prepend is not mistaken for a first send.
    for (const item of items) {
      if (
        item.kind === "group" &&
        (item.role === "user" || assistantGroupCanOwnActiveRunStatus(item))
      ) {
        for (const source of item.messages) {
          entries.set(source.key, item.role === "user" ? source.key : null);
          if (item.role === "user" && readChatThreadMessageIdentity(source.message)?.sendId) {
            userSubmissionKeys.add(source.key);
          }
        }
      } else if (item.kind === "stream") {
        entries.set(item.key, null);
      }
    }
    this.input = items;
    this.projected = entries;
    this.userSubmissionKeys = userSubmissionKeys;
    return entries;
  }

  sync(
    entries: ReadonlyMap<string, string | null>,
    enabled: boolean,
    userSubmissionKeys: ReadonlySet<string> = this.userSubmissionKeys,
  ): void {
    if (entries === this.committed && enabled === this.enabled) {
      return;
    }
    const keys = [...entries.keys()];
    const previousHead = keys.findIndex((key) => this.committed.has(key));
    this.pending.clear();
    for (const [index, key] of keys.entries()) {
      const identity = entries.get(key);
      if (identity == null) {
        continue;
      }
      if (
        enabled &&
        this.enabled &&
        (this.committed.size === 0 || (previousHead >= 0 && index >= previousHead)) &&
        !this.seen.has(identity)
      ) {
        let captured: ((element: HTMLElement) => boolean) | undefined;
        try {
          // Capture active registrations now. A plugin activated after this
          // commit must not animate an earlier message when a virtual row mounts.
          // Only locally submitted prompts have the stable send identity needed
          // to distinguish them from user messages received from other clients.
          if (userSubmissionKeys.has(identity)) {
            captured = this.captureUserMessageEffect?.(identity);
          }
        } catch {
          // A UI contribution cannot make transcript projection fail.
        }
        this.pending.set(identity, { key, effect: captured });
      }
      if (!this.refs.has(key)) {
        let current: HTMLElement | undefined;
        this.refs.set(key, (element) => {
          if (current !== element) {
            const previous = current;
            if (current) {
              this.active.get(current)?.();
            }
            current = element instanceof HTMLElement ? element : undefined;
            if (current) {
              this.elements.set(key, current);
            } else if (previous && this.elements.get(key) === previous) {
              this.elements.delete(key);
            }
          }
          const pending = this.pending.get(identity);
          if (current && pending) {
            pending.element = current;
            if (!pending.effect) {
              this.pending.delete(identity);
              this.enter(current);
            }
          }
        });
      }
    }
    for (const key of this.refs.keys()) {
      if (!entries.has(key)) {
        this.refs.get(key)?.(undefined);
        this.refs.delete(key);
      }
    }
    // Acknowledgement and remount are not new arrivals for a submitted prompt.
    for (const identity of entries.values()) {
      if (identity !== null) {
        this.seen.add(identity);
      }
    }
    this.committed = entries;
    this.enabled = enabled;
  }

  private enter(element: HTMLElement): void {
    this.active.get(element)?.();
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const finish = () => {
      if (this.active.get(element) !== finish) {
        return;
      }
      this.active.delete(element);
      element.removeEventListener("animationend", settled);
      element.removeEventListener("animationcancel", settled);
      // A completed class otherwise replays when the retained bubble is reparented.
      element.classList.remove("chat-bubble--enter");
    };
    const settled = (event: AnimationEvent) => {
      if (event.target === element && event.animationName === "chat-message-enter") {
        finish();
      }
    };
    this.active.set(element, finish);
    element.addEventListener("animationend", settled);
    element.addEventListener("animationcancel", settled);
    element.classList.add("chat-bubble--enter");
  }

  refFor = (key: string): ((element?: Element) => void) | undefined => this.refs.get(key);
  didCommit(): void {
    for (const [identity, pending] of this.pending) {
      const element = pending.element;
      if (!pending.effect || !element) {
        this.pending.delete(identity);
        continue;
      }
      queueMicrotask(() => {
        if (this.pending.get(identity) !== pending) {
          return;
        }
        this.pending.delete(identity);
        if (!this.enabled || !element.isConnected || this.elements.get(pending.key) !== element) {
          return;
        }
        this.active.get(element)?.();
        let handled = false;
        try {
          handled = pending.effect?.(element) === true;
        } catch {
          // Rendering and the send path remain owned by the stock transcript.
        }
        if (!handled) {
          this.enter(element);
        }
      });
    }
  }
  disconnect(): void {
    this.enabled = false;
    this.pending.clear();
    this.elements.clear();
    for (const finish of this.active.values()) {
      finish();
    }
  }
}
