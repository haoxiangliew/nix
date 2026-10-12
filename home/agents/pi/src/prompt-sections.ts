/**
 * Turns a system prompt that an extension forced by returning `systemPrompt` from
 * `before_agent_start` back into pi's own prompt, and moves any text it appended into a prompt
 * section. While a prompt is forced, pi re-sends the whole system prompt and tool list on every
 * change, which misses the prompt cache. A prompt replaced outright stays forced. No settings.
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

    // Without the force, this renders pi's own prompt.
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
