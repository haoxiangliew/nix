/**
 * Restores pi's own system prompt when an extension forces one by returning `systemPrompt` from
 * `before_agent_start`. It moves any text the extension appended into a prompt section. While an
 * extension forces the prompt, pi re-sends the whole system prompt and tool list on every change,
 * which misses the prompt cache. If an extension replaces the prompt outright, it stays forced.
 * No settings.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECTION = "appended";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const options = event.systemPromptOptions;
    const forced = options.forceSystemPrompt;

    if (forced === undefined) {
      return;
    }

    delete options.forceSystemPrompt;

    // Without forceSystemPrompt, this renders pi's own prompt.
    const prompt = event.systemPrompt;

    if (forced === prompt) {
      return;
    }

    if (!forced.startsWith(`${prompt}\n\n`)) {
      options.forceSystemPrompt = forced;

      return;
    }

    options.sections = { ...options.sections, [SECTION]: forced.slice(prompt.length + 2) };
  });
}
