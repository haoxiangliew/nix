/**
 * $name anywhere in a prompt loads that skill. pi's /skill:name works only at the start of a
 * prompt. No settings.
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { errorMessage } from "./lib/settings.ts";

interface Skill {
  description: string;
  path: string;
}

const MENTION = /(^|\s)\$([a-z0-9][a-z0-9_-]*)/g;

const PARTIAL = /(?:^|\s)\$([a-z0-9_-]*)$/;

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

// Matches pi's /skill:name block, so the TUI collapses a single skill.
function skillBlock(name: string, path: string): string {
  const body = stripFrontmatter(readFileSync(path, "utf8")).trim();

  return `<skill name="${name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${body}\n</skill>`;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) => ({
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
    }));
  });

  // Pi expands /skill: and templates after this hook, so slash commands pass through.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || event.text.startsWith("/") || !event.text.includes("$")) {
      return { action: "continue" };
    }

    const known = loadedSkills(pi);
    const used = new Map<string, string>();

    const text = event.text.replace(MENTION, (match, space: string, name: string) => {
      const skill = known.get(name);

      if (skill === undefined) {
        return match;
      }

      used.set(name, skill.path);

      return `${space}${name}`;
    });

    if (used.size === 0) {
      return { action: "continue" };
    }

    // Pi sends the original prompt when an input handler throws, so this blocks it instead. The
    // agent would otherwise run without a skill the prompt names.
    try {
      const blocks = [...used].map(([name, path]) => skillBlock(name, path));

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
