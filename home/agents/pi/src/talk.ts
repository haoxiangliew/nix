/**
 * /talk or shift+tab removes the edit and write tools and adds the talk prompt. Bash stays for research.
 * --talk starts with it on.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROMPT = "@prompt@";

const WRITE_TOOLS = new Set(["edit", "write"]);

const CONTEXT_TYPE = "talk-mode-context";

// Blocks writes and adds the talk prompt to each turn while talk mode is on.
function enforce(pi: ExtensionAPI, isEnabled: () => boolean): void {
  pi.on("tool_call", async (event) => {
    if (isEnabled() && WRITE_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: "Talk mode is read-only. Propose the change instead; /talk turns it off.",
      };
    }
  });

  pi.on("before_agent_start", async () => {
    if (isEnabled()) {
      return { message: { customType: CONTEXT_TYPE, content: PROMPT, display: false } };
    }
  });

  // Drops talk prompts left in history once talk mode is off.
  pi.on("context", async (event) => {
    if (!isEnabled()) {
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
  let toolsBefore: string[] | undefined;

  enforce(pi, () => enabled);

  pi.registerFlag("talk", {
    description: "Start in talk mode (read-only)",
    type: "boolean",
    default: false,
  });

  function apply(ctx: ExtensionContext): void {
    if (enabled) {
      toolsBefore ??= pi.getActiveTools();
      pi.setActiveTools(toolsBefore.filter((name) => !WRITE_TOOLS.has(name)));
    } else if (toolsBefore) {
      pi.setActiveTools(toolsBefore);
      toolsBefore = undefined;
    }

    ctx.ui.setStatus("talk", enabled ? ctx.ui.theme.fg("warning", "talk") : undefined);
  }

  function toggle(ctx: ExtensionContext): void {
    enabled = !enabled;
    apply(ctx);
    pi.appendEntry("talk-mode", enabled);
    ctx.ui.notify(enabled ? "Talk mode on. Edit and write are off." : "Talk mode off.");
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
    const saved = ctx.sessionManager
      .getEntries()
      .findLast((e) => e.type === "custom" && e.customType === "talk-mode");

    enabled = saved?.type === "custom" ? saved.data === true : pi.getFlag("talk") === true;
    apply(ctx);
  });
}
