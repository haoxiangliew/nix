/**
 * /talk or shift+tab turns talk mode on and off. Talk mode blocks the write tools and adds the
 * talk prompt as a system prompt section. Bash stays available for research. Blocking calls
 * instead of removing the tools keeps the tool list the same. On models that accept system
 * messages mid-conversation, pi sends one system message per toggle and the prompt cache still
 * hits. On other models, pi folds the section into the first system prompt, so each toggle misses
 * the cache. Each branch keeps its own setting, including after /tree. --talk starts with it on.
 * The `talk` key in settings.json configures it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Type, type Static } from "typebox";

import { loadOrReport } from "./lib/settings.ts";

const Config = Type.Object(
  {
    // Required, so talk mode stays off until it's set.
    prompt: Type.String({ minLength: 1 }),
    blockedTools: Type.Array(Type.String(), { default: ["edit", "write"] }),
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

const SECTION = "talk_mode";

function blockWrites(pi: ExtensionAPI, current: () => Config | undefined): void {
  pi.on("tool_call", async (event) => {
    if (current()?.blockedTools.includes(event.toolName)) {
      return {
        block: true,
        reason:
          "Talk mode is read-only. Suggest the change instead. The user can turn it off with /talk.",
      };
    }
  });
}

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let config: Config | undefined;

  blockWrites(pi, () => (enabled ? config : undefined));

  pi.on("before_agent_start", async (event) => {
    if (enabled && config !== undefined) {
      event.systemPromptOptions.sections[SECTION] = config.prompt;
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

  // Pi skips this shortcut unless keybindings.json moves app.thinking.cycle off shift+tab.
  pi.registerShortcut("shift+tab", {
    description: "Toggle read-only talk mode",
    handler: async (ctx) => toggle(ctx),
  });

  function restore(ctx: ExtensionContext): void {
    const saved = ctx.sessionManager
      .getBranch()
      .findLast((e) => e.type === "custom" && e.customType === "talk-mode");

    enabled =
      config !== undefined &&
      (saved?.type === "custom" ? saved.data === true : pi.getFlag("talk") === true);

    showStatus(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    config = loadOrReport(ctx, "Talk mode", "talk", Config);
    restore(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => restore(ctx));
}
