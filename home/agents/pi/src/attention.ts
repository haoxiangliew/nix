/**
 * Notifies when pi waits on a prompt or finishes a run, and reports prompts to herdr and Rex as
 * blocked. herdr shows a turn that ends on a question as done, so this tells the agent to ask with
 * ask_user_question. The `attention` key in settings.json configures it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Type, type Static } from "typebox";

import { multiplexer } from "./lib/multiplexer.ts";
import { loadOrReport } from "./lib/settings.ts";

const Config = Type.Object(
  {
    title: Type.String({ minLength: 1, default: "pi" }),
    // Matches herdr's ui.toast.delay_seconds.
    delayMs: Type.Integer({ minimum: 0, default: 1000 }),
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

const HERDR_TIMEOUT_MS = 2000;

const ASK_TOOL = "ask_user_question";

const ASK_RULE = `Use ${ASK_TOOL} only for a choice the user hasn't made and you can't make yourself. Explain the options in your message and say which one you recommend before you ask. Show drafts and diffs in your message and end your turn, instead of asking whether to apply them. Don't end your turn with a question in chat.`;

const paneId = multiplexer === "herdr" ? process.env.HERDR_PANE_ID : undefined;

// pi reports its state to Rex with OSC 7501, but shows a ctx.ui.custom() dialog as working. While
// one is open, this reports pi as blocked, and again after each of pi's own reports. When it closes, this
// writes pi's latest report again, since pi only reports changes. It reports only after pi has, so
// pi's support check and PI_PROGRAM_STATUS still apply.
const reportsStatus = multiplexer === "rex";

// How pi's reports on its own record start. They have no `id`.
const REPORT_PREFIX = "\u001B]7501;state=";

// pi's latest report, which is written again when the dialog closes.
let piReport: string | undefined;

let blockedReport: string | undefined;

// Writes without the watch, so this extension's reports aren't taken for pi's.
let writeRaw: ((chunk: string) => boolean) | undefined;

let unwatch: (() => void) | undefined;

function noteReport(chunk: string | Uint8Array): void {
  if (chunk instanceof Uint8Array || !chunk.startsWith(REPORT_PREFIX) || chunk.includes(":id=")) {
    return;
  }

  piReport = chunk;

  if (blockedReport !== undefined && !chunk.startsWith(`${REPORT_PREFIX}clear`)) {
    writeRaw?.(blockedReport);
  }
}

function watchReports(): void {
  const { stdout } = process;
  const write = stdout.write.bind(stdout);

  // SAFETY: the wrapper passes its arguments to stdout's own write unchanged and returns its
  // result, so it takes whatever either of write's overloads takes.
  const watching = ((...args: Parameters<typeof write>) => {
    const written = write(...args);

    noteReport(args[0]);

    return written;
  }) as typeof stdout.write;

  stdout.write = watching;
  writeRaw = (chunk) => write(chunk);

  unwatch = () => {
    if (stdout.write === watching) {
      stdout.write = write;
    }
  };
}

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

function reportBlocked(label: string): void {
  if (piReport === undefined || writeRaw === undefined) {
    return;
  }

  blockedReport = `\u001B]7501;state=blocked:app=pi:msg=${Buffer.from(label).toString("base64")}\u001B\\`;
  writeRaw(blockedReport);
}

function reportClosed(): void {
  if (blockedReport === undefined || piReport === undefined || writeRaw === undefined) {
    return;
  }

  blockedReport = undefined;
  writeRaw(piReport);
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

// herdr doesn't notify for the active tab of the focused workspace. Check on every call because
// panes move. An unknown answer counts as skipped, so pi notifies.
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

// Subagents and print or RPC runs have no one watching.
function watched(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui";
}

export default function (pi: ExtensionAPI) {
  let config: Config | undefined;
  let prompt: string | undefined;
  // Events set these because a timer can outlive ctx, which throws after the session ends.
  let busy = false;
  let live = true;

  pi.on("session_start", async (_event, ctx) => {
    config = loadOrReport(ctx, "The attention extension", "attention", Config);

    if (reportsStatus && watched(ctx) && unwatch === undefined) {
      watchReports();
    }
  });

  // Subagents start and end their own sessions without a UI, and share this module with the session
  // that owns the terminal, so only that session watches pi's reports.
  pi.on("session_shutdown", async (_event, ctx) => {
    live = false;

    if (!watched(ctx)) {
      return;
    }

    unwatch?.();
    unwatch = undefined;
    writeRaw = undefined;
    piReport = undefined;
    blockedReport = undefined;
  });

  pi.on("agent_start", async () => {
    busy = true;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const options = event.systemPromptOptions;

    if (watched(ctx) && options.selectedTools.includes(ASK_TOOL)) {
      (options.toolGuidelines[ASK_TOOL] ??= []).push(ASK_RULE);
    }
  });

  pi.on("ui_prompt_start", async (event, ctx) => {
    // An idle agent means the user opened the dialog, such as the /fast picker.
    if (config === undefined || !watched(ctx) || ctx.isIdle()) {
      return;
    }

    const label = firstLine(event.title) ?? "Waiting for input";

    prompt = label;
    pi.events.emit("herdr:blocked", { active: true, label });

    if (event.kind === "custom") {
      reportBlocked(label);
    }

    notifyLater(pi, config, () => live && prompt === label, label);
  });

  pi.on("ui_prompt_end", async (event) => {
    if (prompt === undefined) {
      return;
    }

    prompt = undefined;
    pi.events.emit("herdr:blocked", { active: false });

    if (event.kind === "custom") {
      reportClosed();
    }
  });

  pi.on("agent_settled", async (event, ctx) => {
    busy = false;

    // Esc means the user is already at the terminal.
    if (config !== undefined && watched(ctx) && !event.aborted) {
      notifyLater(pi, config, () => live && !busy, "Ready for input");
    }
  });
}
