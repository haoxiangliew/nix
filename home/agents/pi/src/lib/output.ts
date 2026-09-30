import type { MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

const OUTPUT = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

// Start events carry no content and arrive with the response headers. SSE pings never reach
// extensions.
export function isModelOutput(event: MessageUpdateEvent): boolean {
  const update = event.assistantMessageEvent;

  return OUTPUT.has(update.type) && "delta" in update && update.delta.length > 0;
}
