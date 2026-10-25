/**
 * $name anywhere in a prompt loads that skill. pi's /skill:name works only at the start of a
 * prompt. No settings.
 *
 * Other extensions use these pi.events channels. Handlers answer synchronously, during emit:
 * - "skill-mention:autocomplete" { provide(provider) }: a $name provider for their own
 *   editors, which pi's built-in autocomplete doesn't reach. pi-review uses it.
 * - "skill-mention:expand" { text, done(result) }: for text the user typed into an extension's
 *   prompt. done() gets { text, blocks } with the $ stripped from known skills, or { error }. The
 *   sender puts the blocks first. This extension's input handler skips extension prompts, so
 *   senders opt in here.
 */

import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

import {
  parseSkillBlock,
  stripFrontmatter,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { errorMessage } from "./lib/settings.ts";

interface Skill {
  description: string;
  path: string;
}

const MENTION = /(^|\s)\$([a-z0-9][a-z0-9_-]*)/g;

const PARTIAL = /(?:^|\s)\$([a-z0-9_-]*)$/;

const AutocompleteRequest = Type.Object({
  provide: Type.Function([Type.Unknown()], Type.Void()),
});

const ExpandRequest = Type.Object({
  text: Type.String(),
  done: Type.Function([Type.Unknown()], Type.Void()),
});

function loadedSkills(pi: ExtensionAPI): Map<string, Skill> {
  const found = new Map<string, Skill>();

  for (const command of pi.getCommands()) {
    const name = command.name.replace(/^skill:/, "");

    if (command.source === "skill" && !found.has(name)) {
      found.set(name, { description: command.description ?? "", path: command.sourceInfo.path });
    }
  }

  return found;
}

function suggestions(skills: Map<string, Skill>, partial: string): AutocompleteItem[] {
  return [...skills]
    .filter(([name]) => name.includes(partial))
    .toSorted(
      ([a], [b]) =>
        Number(!a.startsWith(partial)) - Number(!b.startsWith(partial)) || a.localeCompare(b),
    )
    .map(([name, skill]) => ({
      value: `$${name} `,
      label: `$${name}`,
      description: skill.description.slice(0, 80),
    }));
}

// Falls back to `current` when the cursor isn't on a $name.
function withSkills(pi: ExtensionAPI, current: AutocompleteProvider): AutocompleteProvider {
  return {
    triggerCharacters: ["$"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const partial = (lines[cursorLine] ?? "").slice(0, cursorCol).match(PARTIAL)?.[1];
      const items = partial === undefined ? [] : suggestions(loadedSkills(pi), partial);

      return items.length > 0
        ? { prefix: `$${partial}`, items }
        : current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion: (...args) => current.applyCompletion(...args),
    shouldTriggerFileCompletion: (...args) =>
      current.shouldTriggerFileCompletion?.(...args) ?? true,
  };
}

// For editors outside pi's own, which complete $name only.
const noCompletion: AutocompleteProvider = {
  getSuggestions: async () => null,
  applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
    const line = lines[cursorLine] ?? "";
    const start = cursorCol - prefix.length;

    return {
      lines: lines.with(cursorLine, line.slice(0, start) + item.value + line.slice(cursorCol)),
      cursorLine,
      cursorCol: start + item.value.length,
    };
  },
};

// Builds the same block as pi's /skill:name, so the TUI collapses a single skill. Pi exports a
// parser for the block but no builder, so formatMatchesPi() checks that pi still parses it.
function formatSkillBlock(name: string, path: string, body: string): string {
  return `<skill name="${name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${body}\n</skill>`;
}

function skillBlock(name: string, path: string): string {
  return formatSkillBlock(name, path, stripFrontmatter(readFileSync(path, "utf8")).trim());
}

function formatMatchesPi(): boolean {
  const parsed = parseSkillBlock(`${formatSkillBlock("a", "/x/SKILL.md", "body")}\n\nprompt`);

  return (
    parsed?.name === "a" &&
    parsed.location === "/x/SKILL.md" &&
    parsed.content === "References are relative to /x.\n\nbody" &&
    parsed.userMessage === "prompt"
  );
}

// Strips the $ from known skills and returns their blocks. Throws when a skill file can't be read.
function expand(pi: ExtensionAPI, text: string) {
  const known = loadedSkills(pi);
  const used = new Map<string, string>();

  const stripped = text.replace(MENTION, (match, space: string, name: string) => {
    const skill = known.get(name);

    if (skill === undefined) {
      return match;
    }

    used.set(name, skill.path);

    return `${space}${name}`;
  });

  return {
    text: stripped,
    blocks: [...used].map(([name, path]) => skillBlock(name, path)),
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) => withSkills(pi, current));

    // The skill still reaches the model, but the TUI shows the full block instead of collapsing it.
    if (!formatMatchesPi()) {
      ctx.ui.notify(
        "pi's skill block format changed, so $name skills won't collapse. Update skill-mention.ts.",
        "warning",
      );
    }
  });

  pi.events.on("skill-mention:autocomplete", (data) => {
    Value.Assert(AutocompleteRequest, data);
    data.provide(withSkills(pi, noCompletion));
  });

  pi.events.on("skill-mention:expand", (data) => {
    Value.Assert(ExpandRequest, data);

    try {
      data.done(expand(pi, data.text));
    } catch (error) {
      data.done({ error: errorMessage(error) });
    }
  });

  // Pi expands /skill: and templates after this hook, so slash commands pass through.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || event.text.startsWith("/") || !event.text.includes("$")) {
      return { action: "continue" };
    }

    // Pi sends the original prompt when an input handler throws, so this blocks it instead. The
    // agent would otherwise run without a skill the prompt names.
    try {
      const { text, blocks } = expand(pi, event.text);

      if (blocks.length === 0) {
        return { action: "continue" };
      }

      return {
        action: "transform",
        text: `${blocks.join("\n\n")}\n\n${text}`,
        images: event.images,
      };
    } catch (error) {
      ctx.ui.notify(
        `A skill failed to load, so pi didn't send the prompt. ${errorMessage(error)}`,
        "error",
      );
      ctx.ui.setEditorText(event.text);

      return { action: "handled" };
    }
  });
}
