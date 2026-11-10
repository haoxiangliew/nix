import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  assertOAuthRequest,
  cliArguments,
  mockReply,
  okText,
  profileHeaders,
  runLocalCli,
} from "./claude-profile.ts";

const timeoutMs = 30_000;

const turnPrompt = "Read probe.txt with the Read tool, then reply exactly OK.";

const ModelBody = Type.Object({ model: Type.String() });

export interface TurnRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
}

/** Two requests of one CLI prompt, a Read tool call and then the final reply. */
export interface TurnCapture {
  readonly prompt: string;
  readonly toolName: string;
  /** message.id of the first reply. */
  readonly replyId: string;
  /** request-id header of the first reply. */
  readonly requestId: string;
  readonly requests: readonly TurnRequest[];
}

function toolUseEvents(file: string) {
  return [
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_01LocalTurnProbe", name: "Read", input: {} },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: file }) },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ] as const;
}

function localId(prefix: string): string {
  return `${prefix}_01LocalTurnProbe${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function replyModel(rawBody: string): string {
  const body: unknown = JSON.parse(rawBody);

  if (!Value.Check(ModelBody, body)) {
    throw new Error("Claude CLI turn request has no model.");
  }

  return body.model;
}

const probeFile = "probe.txt";

// Like discoverCliProfile, but the mock answers with a Read tool call so the CLI sends a second
// request for the same prompt.
export async function discoverTurnProfile(
  executable: string,
  model: string,
  env: Readonly<Record<string, string>>,
): Promise<TurnCapture> {
  const failureMessage = "Claude CLI multi-request probe did not complete valid local requests.";
  const first = { id: localId("msg"), requestId: localId("req") };
  const requests: TurnRequest[] = [];

  await runLocalCli({
    args: cliArguments(executable, model, turnPrompt, ["Read"]),
    env,
    tempPrefix: "claude-turns-",
    setup: (cwd) => writeFile(join(cwd, probeFile), "OK\n"),
    timeoutMs,
    timeoutMessage: "Claude CLI multi-request probe timed out.",
    failureMessage,
    async handle(request, cwd) {
      assertOAuthRequest(request.headers);
      const rawBody = await request.text();
      const count = requests.push({ headers: profileHeaders(request.headers), rawBody });
      const answerModel = replyModel(rawBody);

      if (count === 1) {
        return mockReply({
          id: first.id,
          model: answerModel,
          stopReason: "tool_use",
          content: toolUseEvents(join(cwd, probeFile)),
          headers: { "request-id": first.requestId },
        });
      }

      if (count === 2) {
        return mockReply({
          id: localId("msg"),
          model: answerModel,
          stopReason: "end_turn",
          content: okText,
          headers: { "request-id": localId("req") },
        });
      }

      throw new Error("Unexpected extra request.");
    },
  });

  if (requests.length !== 2) {
    throw new Error(failureMessage);
  }

  return {
    prompt: turnPrompt,
    toolName: "Read",
    replyId: first.id,
    requestId: first.requestId,
    requests,
  };
}
