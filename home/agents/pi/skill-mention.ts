/**
 * $name anywhere in a prompt loads that skill, like /skill:name at the start of one.
 * Only adds an autocomplete provider, so it never wraps the editor.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

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

// Prefix matches first, then alphabetical.
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

  // pi expands /skill: and templates after this hook, so slash commands pass through.
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

    const blocks = [...used].flatMap(([name, path]) => {
      try {
        return [skillBlock(name, path)];
      } catch (err) {
        ctx.ui.notify(
          `Could not read $${name}: ${err instanceof Error ? err.message : err}`,
          "error",
        );

        return [];
      }
    });

    if (blocks.length === 0) {
      return { action: "continue" };
    }

    return { action: "transform", text: `${blocks.join("\n\n")}\n\n${text}`, images: event.images };
  });
}
