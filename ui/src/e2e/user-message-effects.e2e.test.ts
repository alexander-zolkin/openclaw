import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

type EffectCall = {
  connected: boolean;
  composerConnected: boolean;
  composerTextarea: boolean;
  sessionKey: string;
  agentId: string;
  messageId: string;
};

declare global {
  interface Window {
    openclawUserMessageEffectProof: { calls: EffectCall[]; retired: boolean };
  }
}

const fixtureSource = `
export default {
  id: "message-effect-proof",
  activate(host) {
    const proof = window.openclawUserMessageEffectProof = { calls: [], retired: false };
    const removeBroken = host.ui.registerUserMessageEffect({
      id: "a-broken",
      onEntry() { throw new Error("Synthetic message effect failure"); },
    });
    const removeObserver = host.ui.registerUserMessageEffect({
      id: "b-observer",
      onEntry(context) {
        proof.calls.push({
          connected: context.element.isConnected,
          composerConnected: context.composerElement?.isConnected === true,
          composerTextarea: context.composerElement instanceof HTMLTextAreaElement,
          sessionKey: context.sessionKey,
          agentId: context.agentId,
          messageId: context.messageId,
        });
        context.signal.addEventListener("abort", () => { proof.retired = true; });
        return true;
      },
    });
    host.onEvent("proof.remove-message-effects", () => {
      removeBroken();
      removeObserver();
    });
  },
};
`;

const suite = createControlUiE2eSuite({ name: "Control UI user message effects" });

suite.define(() => {
  it("delivers a connected local row once and isolates retired or throwing effects", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-message-effect-"));
    try {
      await mkdir(path.join(fixtureRoot, "browser"));
      await symlink(
        path.resolve(import.meta.dirname, "../../../node_modules"),
        path.join(fixtureRoot, "node_modules"),
        "dir",
      );
      await writeFile(path.join(fixtureRoot, "browser/index.ts"), fixtureSource);
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
        const gateway = await installMockGateway(page, {
          nativePlugins: [
            { pluginId: "message-effect-proof", rootDir: fixtureRoot, source: "browser/index.ts" },
          ],
          historyMessages: [
            { role: "user", content: [{ type: "text", text: "Historical prompt" }], timestamp: 1 },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("plugins.controlUi.report");
        expect(await page.evaluate(() => window.openclawUserMessageEffectProof.calls)).toEqual([]);

        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Synthetic local message");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        await expect
          .poll(() => page.evaluate(() => window.openclawUserMessageEffectProof.calls.length))
          .toBe(1);
        expect(await page.evaluate(() => window.openclawUserMessageEffectProof.calls)).toEqual([
          {
            connected: true,
            composerConnected: true,
            composerTextarea: true,
            sessionKey: "agent:main:main",
            agentId: "main",
            messageId: expect.stringMatching(/^msg:send:/u),
          },
        ]);
        const params = request.params as { idempotencyKey: string };
        await gateway.emitChatFinal({
          runId: params.idempotencyKey,
          text: "Synthetic final reply",
        });
        await page
          .locator(".chat-thread-inner p")
          .filter({ hasText: "Synthetic final reply" })
          .waitFor();
        expect(await page.evaluate(() => window.openclawUserMessageEffectProof.calls)).toHaveLength(
          1,
        );
        const diagnostics = await page.evaluate(() => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime: { context: { plugins: { errors: Array<{ message: string }> } } };
          };
          return app.runtime.context.plugins.errors;
        });
        expect(diagnostics).toContainEqual({
          pluginId: "message-effect-proof",
          message: "Synthetic message effect failure",
        });

        await page.getByRole("link", { name: "Agents", exact: true }).click();
        await page.waitForURL(/\/agents/u);
        await navigateToControlUiSession(page, "agent:main:main");
        expect(await page.evaluate(() => window.openclawUserMessageEffectProof.calls)).toHaveLength(
          1,
        );
        await gateway.emitGatewayEvent("proof.remove-message-effects", {});
        await expect
          .poll(() => page.evaluate(() => window.openclawUserMessageEffectProof.retired))
          .toBe(true);
        await composer.fill("Send after effect retirement");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page
          .locator(".chat-group.user")
          .filter({ hasText: "Send after effect retirement" })
          .waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(2);
        expect(await page.evaluate(() => window.openclawUserMessageEffectProof.calls)).toHaveLength(
          1,
        );
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
