/**
 * Draws mermaid blocks as Unicode diagrams with lovely-mermaid, which reads more of mermaid than the
 * renderer built into pi. Quotes labels that contain a semicolon and redraws wide flowcharts top to
 * bottom, so more diagrams fit the pane. A diagram that still can't be drawn shows its source and
 * why. Only the display changes, not the message. pi's own renderer runs first, so set
 * `markdown.mermaid` to "off" in settings.json.
 */

import type {
  ExtensionAPI,
  ExtensionUIContext,
  MarkdownTransformContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";

import { Marked, type Token } from "@earendil-works/pi-tui";
import { type AnsiTheme, diagramKind, type MermaidArt, render, toAnsi } from "lovely-mermaid";

// The limits come from real diagrams. 30-character sequence messages fit about 110 columns, and the
// top to bottom redraw cuts edge labels from about 30 characters. lovely-mermaid prints <br/> in
// sequence diagrams as text.
const RULE =
  "Mermaid blocks render as text diagrams in a terminal about 100 columns wide. Only flowchart, sequence, state, class, ER, pie, mindmap, timeline, and gitGraph diagrams draw. Keep node labels under 30 characters, edge labels under 20, and sequence messages under 30, with no <br/> in sequence diagrams.";

const parser = new Marked();

// A semicolon ends a statement, so it cuts an unquoted label short. HTML entities end in one.
const NODE_LABEL = /([[({])([^[\](){}|"\n]*;[^[\](){}|"\n]*)([\])}])/g;
const EDGE_LABEL = /([-=.][->=ox]?\|)([^|"\n]*;[^|"\n]*)\|/g;

const SIDEWAYS = /^(\s*(?:flowchart|graph|direction)\s+)(?:LR|RL)\b/gm;

type Drawing = { art: MermaidArt } | { note?: string };

function quoteLabels(src: string): string {
  return src.replaceAll(NODE_LABEL, '$1"$2"$3').replaceAll(EDGE_LABEL, '$1"$2"|');
}

function topDown(src: string): string {
  return src.replaceAll(SIDEWAYS, "$1TB");
}

// The source as written comes first, so a diagram that already works is drawn unchanged.
function drafts(src: string): string[] {
  if (diagramKind(src) !== "flowchart") {
    return [src];
  }

  const quoted = quoteLabels(src);

  return [...new Set([src, quoted, topDown(quoted)])];
}

// A diagram is unfinished while it streams, so warnings only count once it ends.
function draw(src: string, width: number, streaming: boolean): Drawing {
  const widths: number[] = [];
  const warnings: string[] = [];

  for (const draft of drafts(src)) {
    const art = render(draft);

    if (art === null) {
      continue;
    }

    if (!streaming && art.warnings.length > 0) {
      warnings.push(...art.warnings);
    } else if (art.width <= width) {
      return { art };
    } else {
      widths.push(art.width);
    }
  }

  return streaming ? {} : { note: failure(widths, warnings, width) };
}

function failure(widths: number[], warnings: string[], width: number): string | undefined {
  if (widths.length > 0) {
    return `Mermaid diagram needs ${Math.min(...widths)} columns, the pane has ${width}`;
  }

  return warnings[0] && `Mermaid diagram not drawn: ${warnings[0]}`;
}

function isMermaid(token: Token): token is Token & { type: "code"; text: string } {
  return (
    token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid"
  );
}

// Inline code keeps each row's spacing. The fence is longer than any backtick run in the row.
function codeSpan(line: string): string {
  const content = line || "\u00A0";
  const longest = Math.max(0, ...Array.from(content.matchAll(/`+/g), (run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";

  return `${fence}${padding}${content}${padding}${fence}`;
}

function themed(art: MermaidArt, theme: Theme): string[] {
  const color = (name: ThemeColor) => theme.getFgAnsi(name).slice(2, -1);
  const roles: AnsiTheme = {
    border: color("borderMuted"),
    text: color("text"),
    edge: color("accent"),
    edgeLabel: color("muted"),
    title: `1;${color("accent")}`,
  };
  // A `click` link would underline every cell of its node, borders included.
  const styled = art.styled.map((row) => row.map((span) => ({ ...span, href: undefined })));

  return toAnsi({ ...art, styled }, roles);
}

function drawBlock(
  token: Token & { text: string },
  context: MarkdownTransformContext,
  theme?: Theme,
) {
  const drawing = draw(token.text, context.availableWidth, context.isStreaming);

  if ("art" in drawing) {
    const lines = theme ? themed(drawing.art, theme) : drawing.art.plain;

    // Markdown hard breaks keep each row on its own line.
    return `${lines.map(codeSpan).join("  \n")}\n`;
  }

  if (drawing.note === undefined) {
    return token.raw;
  }

  return `${token.raw}\n${codeSpan(theme?.fg("warning", drawing.note) ?? drawing.note)}  \n`;
}

export default function (pi: ExtensionAPI) {
  let ui: ExtensionUIContext | undefined;

  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.ui;
  });

  // Diagrams are drawn only in the TUI. The rule never changes, so the prompt cache still hits.
  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.mode === "tui") {
      event.systemPromptOptions.promptGuidelines.push(RULE);
    }
  });

  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType === "assistant-thinking" || !/mermaid/i.test(markdown)) {
      return markdown;
    }

    return parser
      .lexer(markdown)
      .map((token) => (isMermaid(token) ? drawBlock(token, context, ui?.theme) : token.raw))
      .join("");
  });
}
