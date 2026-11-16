// Spliced into pi's MCP HTTP transport by home/agents/default.nix. Pi cancels a JSON reply over
// maxBytes; this saves the reply to a file and fails the call with the file's path instead.
const MCP_SPILL_MAX_BYTES = 2 * 1024 * 1024 * 1024;

async function spillMcpBody(read, chunks, file) {
  const { open, rm } = await import("node:fs/promises");
  const handle = await open(file, "wx", 0o600);
  let size = 0;
  let complete = false;

  try {
    for (let chunk = Buffer.concat(chunks); chunk; chunk = await read()) {
      size += chunk.byteLength;

      if (size > MCP_SPILL_MAX_BYTES) {
        throw new Error(`MCP JSON response exceeds ${MCP_SPILL_MAX_BYTES} bytes`);
      }

      await handle.writeFile(chunk);
    }

    complete = true;

    return size;
  } finally {
    await handle.close();

    if (!complete) {
      await rm(file, { force: true });
    }
  }
}

async function readBodyOrSpill(response, maxBytes, signal) {
  if (!response.body) {
    return { text: "", truncated: false };
  }

  const reader = response.body.getReader();
  const cancel = () => reader.cancel().catch(() => {});

  // Resolves to undefined at the end of the body. A cancelled reader also reports the end, so an
  // aborted call has to throw here.
  const read = async () => {
    const { done, value } = await reader.read();

    if (signal?.aborted) {
      throw new McpAbortError();
    }

    return done ? undefined : value;
  };

  const chunks = [];
  let size = 0;
  let complete = false;

  signal?.addEventListener("abort", cancel, { once: true });

  try {
    while (size <= maxBytes) {
      const chunk = await read();

      if (!chunk) {
        complete = true;

        return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated: false };
      }

      chunks.push(chunk);
      size += chunk.byteLength;
    }

    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { randomUUID } = await import("node:crypto");
    const file = join(tmpdir(), `pi-mcp-response-${randomUUID()}.json`);
    const total = await spillMcpBody(read, chunks, file);

    complete = true;

    throw new Error(
      `MCP JSON response is ${total} bytes, over the ${maxBytes} byte limit, so it was not returned. ` +
        `The whole JSON-RPC response is saved to ${file}; the tool result is under .result. ` +
        `Read the parts you need from that file with jq or rg instead of calling the tool again.`,
    );
  } finally {
    signal?.removeEventListener("abort", cancel);

    if (!complete) {
      await cancel();
    }

    reader.releaseLock();
  }
}
