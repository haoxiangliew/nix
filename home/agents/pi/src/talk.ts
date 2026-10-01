/**
 * /talk or shift+tab blocks the write tools and adds the talk prompt to each turn. Bash stays for
 * research. It leaves the tool list and earlier messages alone, since changing either makes the
 * next request miss the prompt cache. --talk starts with it on. Configured by `talk` in
 * settings.json.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Type, type Static } from "typebox";

import { loadOrReport } from "./lib/settings.ts";

const Config = Type.Object(
  {
    // Added to each turn while talk mode is on. Required, so talk mode stays off until it's set.
    prompt: Type.String({ minLength: 1 }),
    // Blocked while talk mode is on.
    blockedTools: Type.Array(Type.String(), { default: ["edit", "write"] }),
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

const CONTEXT_TYPE = "talk-mode-context";

const OFF_PROMPT = "Talk mode is off. You can edit files again.";

function blockWrites(pi: ExtensionAPI, current: () => Config | undefined): void {
  pi.on("tool_call", async (event) => {
    if (current()?.blockedTools.includes(event.toolName)) {
      return {
        block: true,
        reason: "Talk mode is read-only. Propose the change instead; /talk turns it off.",
      };
    }
  });
}

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let config: Config | undefined;
  let turnedOff = false;

  blockWrites(pi, () => (enabled ? config : undefined));

  // Earlier talk prompts stay in history, so the first turn after talk mode turns off says so.
  pi.on("before_agent_start", async () => {
    const content = enabled ? config?.prompt : turnedOff ? OFF_PROMPT : undefined;

    turnedOff = false;

    if (content !== undefined) {
      return { message: { customType: CONTEXT_TYPE, content, display: false } };
    }
  });

  pi.registerFlag("talk", {
    description: "Start in talk mode (read-only)",
    type: "boolean",
    default: false,
  });

  function showStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus("talk", enabled ? ctx.ui.theme.fg("warning", "talk") : undefined);
  }

  function toggle(ctx: ExtensionContext): void {
    if (config === undefined) {
      ctx.ui.notify("Talk mode is off because `talk` in settings.json is invalid.", "error");

      return;
    }

    enabled = !enabled;
    turnedOff = !enabled;
    showStatus(ctx);
    pi.appendEntry("talk-mode", enabled);
    ctx.ui.notify(
      enabled ? `Talk mode on. ${config.blockedTools.join(", ")} are blocked.` : "Talk mode off.",
    );
  }

  pi.registerCommand("talk", {
    description: "Toggle talk mode (read-only)",
    handler: async (_args, ctx) => toggle(ctx),
  });

  // pi skips this shortcut unless keybindings.json moves app.thinking.cycle off shift+tab.
  pi.registerShortcut("shift+tab", {
    description: "Toggle talk mode (read-only)",
    handler: async (ctx) => toggle(ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    config = loadOrReport(ctx, "Talk mode", "talk", Config);

    const entries = ctx.sessionManager.getEntries();
    const saved = entries.findLast((e) => e.type === "custom" && e.customType === "talk-mode");

    const lastPrompt = entries.findLast(
      (e) => e.type === "custom_message" && e.customType === CONTEXT_TYPE,
    );

    enabled =
      config !== undefined &&
      (saved?.type === "custom" ? saved.data === true : pi.getFlag("talk") === true);

    // History can end on a talk prompt while talk mode is off, such as after a restart.
    turnedOff =
      !enabled && lastPrompt?.type === "custom_message" && lastPrompt.content !== OFF_PROMPT;

    showStatus(ctx);
  });
}
