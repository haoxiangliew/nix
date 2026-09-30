/**
 * /talk or shift+tab removes the write tools and adds the talk prompt. Bash stays for research.
 * --talk starts with it on. Configured by `talk` in settings.json.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Type, type Static } from "typebox";

import { loadOrReport } from "./lib/settings.ts";

const Config = Type.Object(
  {
    // Added to each turn while talk mode is on. Required, so talk mode stays off until it's set.
    prompt: Type.String({ minLength: 1 }),
    // Removed and blocked while talk mode is on.
    blockedTools: Type.Array(Type.String(), { default: ["edit", "write"] }),
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

const CONTEXT_TYPE = "talk-mode-context";

// Blocks writes and adds the talk prompt to each turn while talk mode is on.
function enforce(pi: ExtensionAPI, current: () => Config | undefined): void {
  pi.on("tool_call", async (event) => {
    if (current()?.blockedTools.includes(event.toolName)) {
      return {
        block: true,
        reason: "Talk mode is read-only. Propose the change instead; /talk turns it off.",
      };
    }
  });

  pi.on("before_agent_start", async () => {
    const config = current();

    if (config !== undefined) {
      return { message: { customType: CONTEXT_TYPE, content: config.prompt, display: false } };
    }
  });

  // Drops talk prompts left in history once talk mode is off.
  pi.on("context", async (event) => {
    if (current() === undefined) {
      return {
        messages: event.messages.filter(
          (m) => !(m.role === "custom" && m.customType === CONTEXT_TYPE),
        ),
      };
    }
  });
}

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let config: Config | undefined;
  // Restoring a snapshot of all active tools would drop tools enabled while talk mode was on, like web_enable's.
  let removed: string[] = [];

  enforce(pi, () => (enabled ? config : undefined));

  pi.registerFlag("talk", {
    description: "Start in talk mode (read-only)",
    type: "boolean",
    default: false,
  });

  function apply(ctx: ExtensionContext): void {
    const active = pi.getActiveTools();
    const blocked = config?.blockedTools ?? [];

    if (enabled) {
      removed = [...new Set([...removed, ...active.filter((name) => blocked.includes(name))])];
      pi.setActiveTools(active.filter((name) => !blocked.includes(name)));
    } else if (removed.length > 0) {
      pi.setActiveTools([...new Set([...active, ...removed])]);
      removed = [];
    }

    ctx.ui.setStatus("talk", enabled ? ctx.ui.theme.fg("warning", "talk") : undefined);
  }

  function toggle(ctx: ExtensionContext): void {
    if (config === undefined) {
      ctx.ui.notify("Talk mode is off because `talk` in settings.json is invalid.", "error");

      return;
    }

    enabled = !enabled;
    apply(ctx);
    pi.appendEntry("talk-mode", enabled);
    ctx.ui.notify(
      enabled ? `Talk mode on. ${config.blockedTools.join(", ")} are off.` : "Talk mode off.",
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

    const saved = ctx.sessionManager
      .getEntries()
      .findLast((e) => e.type === "custom" && e.customType === "talk-mode");

    enabled =
      config !== undefined &&
      (saved?.type === "custom" ? saved.data === true : pi.getFlag("talk") === true);
    apply(ctx);
  });
}
