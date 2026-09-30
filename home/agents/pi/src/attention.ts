/**
 * Notifies when pi waits on a prompt or finishes, and reports prompts to herdr as blocked.
 * herdr notifies only for panes outside the active tab, so inside herdr this notifies only for the
 * active tab. Outside herdr it notifies through the terminal. Configured by `attention` in
 * settings.json.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Type, type Static } from "typebox";

import { loadOrReport } from "./lib/settings.ts";

const Config = Type.Object(
  {
    title: Type.String({ minLength: 1, default: "pi" }),
    // How long pi waits before notifying. Matches herdr's ui.toast.delay_seconds.
    delayMs: Type.Integer({ minimum: 0, default: 1000 }),
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

const HERDR_TIMEOUT_MS = 2000;

const paneId = process.env.HERDR_ENV === "1" ? process.env.HERDR_PANE_ID : undefined;

interface PaneInfo {
  result?: { pane?: { tab_id?: string; workspace_id?: string } };
}

interface WorkspaceInfo {
  result?: { workspace?: { focused?: boolean; active_tab_id?: string } };
}

// Control characters and semicolons would end the OSC sequence early.
function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split("\n")[0]
    ?.replaceAll(/[\p{Cc};]/gu, " ")
    .trim();

  return line ? line.slice(0, 100) : undefined;
}

async function herdrJson<T>(pi: ExtensionAPI, args: string[]): Promise<T | undefined> {
  const result = await pi.exec("herdr", args, { timeout: HERDR_TIMEOUT_MS });

  if (result.code !== 0) {
    return undefined;
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

// herdr skips its own notification for the active tab of the focused workspace. Checked on every
// call because panes move between tabs. An unknown answer counts as skipped, so pi notifies.
async function herdrSkips(pi: ExtensionAPI, pane: string): Promise<boolean> {
  const info = await herdrJson<PaneInfo>(pi, ["pane", "get", pane]);
  const { tab_id: tab, workspace_id: workspaceId } = info?.result?.pane ?? {};

  return workspaceId === undefined || (await isFocusedTab(pi, workspaceId, tab));
}

async function isFocusedTab(
  pi: ExtensionAPI,
  workspaceId: string,
  tab: string | undefined,
): Promise<boolean> {
  const info = await herdrJson<WorkspaceInfo>(pi, ["workspace", "get", workspaceId]);
  const { focused, active_tab_id: activeTab } = info?.result?.workspace ?? {};

  return focused !== false && activeTab === tab;
}

async function notify(pi: ExtensionAPI, title: string, body: string): Promise<void> {
  if (paneId === undefined) {
    process.stdout.write(`\u001B]777;notify;${title};${body}\u0007`);

    return;
  }

  if (await herdrSkips(pi, paneId)) {
    await pi.exec("herdr", ["notification", "show", title, "--body", body, "--sound", "none"], {
      timeout: HERDR_TIMEOUT_MS,
    });
  }
}

function notifyLater(
  pi: ExtensionAPI,
  config: Config,
  stillWaiting: () => boolean,
  body: string,
): void {
  setTimeout(() => {
    if (stillWaiting()) {
      void notify(pi, config.title, body);
    }
  }, config.delayMs).unref();
}

// Subagent children and print or RPC runs have no one watching.
function watched(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui";
}

export default function (pi: ExtensionAPI) {
  let config: Config | undefined;
  // Label of the prompt reported to herdr, so each start gets exactly one end.
  let prompt: string | undefined;
  // Tracked from events because a timer can outlive its ctx, which throws once the session ends.
  let busy = false;
  let live = true;

  pi.on("session_start", async (_event, ctx) => {
    config = loadOrReport(ctx, "The attention extension", "attention", Config);
  });

  pi.on("session_shutdown", async () => {
    live = false;
  });

  pi.on("agent_start", async () => {
    busy = true;
  });

  pi.on("ui_prompt_start", async (event, ctx) => {
    // An idle agent means the user opened the dialog, such as the /fast picker.
    if (config === undefined || !watched(ctx) || ctx.isIdle()) {
      return;
    }

    const label = firstLine(event.title) ?? "Waiting for input";

    prompt = label;
    pi.events.emit("herdr:blocked", { active: true, label });
    notifyLater(pi, config, () => live && prompt === label, label);
  });

  pi.on("ui_prompt_end", async () => {
    if (prompt === undefined) {
      return;
    }

    prompt = undefined;
    pi.events.emit("herdr:blocked", { active: false });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) {
      return;
    }

    busy = false;

    if (config !== undefined && watched(ctx)) {
      notifyLater(pi, config, () => live && !busy, "Ready for input");
    }
  });
}
