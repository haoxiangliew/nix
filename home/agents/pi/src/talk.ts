/**
 * /talk or shift+tab blocks the write tools and adds the talk prompt to each turn. Bash stays
 * available for research. It leaves the tool list and earlier messages alone, since changing either
 * makes the next request miss the prompt cache. --talk starts with it on. The `talk` key in
 * settings.json configures it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Type, type Static } from "typebox";

import { loadOrReport } from "./lib/settings.ts";

const Config = Type.Object(
  {
    // Talk mode adds this to each turn. It's required, so talk mode stays off until you set it.
    prompt: Type.String({ minLength: 1 }),
    // Talk mode blocks these tools.
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
        reason:
          "Talk mode is read-only. Propose the change instead. The user can turn it off with /talk.",
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
  pi.on("before_agent_start", async (event) => {
    if (event.messageType !== "user") {
      return;
    }

    const content = enabled ? config?.prompt : turnedOff ? OFF_PROMPT : undefined;

    turnedOff = false;

    if (content !== undefined) {
      return { message: { customType: CONTEXT_TYPE, content, display: false } };
    }
  });

  pi.registerFlag("talk", {
    description: "Start in read-only talk mode",
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
      enabled
        ? `Talk mode is on. It blocks ${new Intl.ListFormat("en").format(config.blockedTools)}.`
        : "Talk mode is off.",
    );
  }

  pi.registerCommand("talk", {
    description: "Toggle read-only talk mode",
    handler: async (_args, ctx) => toggle(ctx),
  });

  // pi skips this shortcut unless keybindings.json moves app.thinking.cycle off shift+tab.
  pi.registerShortcut("shift+tab", {
    description: "Toggle read-only talk mode",
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
