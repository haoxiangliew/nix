/**
 * When an extension forces a system prompt that extends pi's own, this restores pi's prompt and
 * moves the appended text into a prompt section. A forced prompt makes pi resend the whole prompt
 * and tool list on every change, which misses the prompt cache. No settings.
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

    // With forceSystemPrompt deleted, this getter builds pi's own prompt.
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
