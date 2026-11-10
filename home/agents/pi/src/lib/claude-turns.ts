import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { CliProfile } from "./claude-profile.ts";
import type { TurnCapture, TurnRequest } from "./claude-turn-profile.ts";

import {
  hasBeta,
  isRequestId,
  isUuid,
  orderedBody,
  toolDurationsHeader,
  toolsUsedHeader,
  toolsUsedValue,
  withPreviousRequest,
} from "./billing-fields.ts";
import { attributionFields } from "./claude-attribution.ts";
import { validateCliChecksum, type CliSignerConfig } from "./claude-signer.ts";

export const threadsBetaPrefix = "message-threads-";

const TextBlock = Type.Object({ type: Type.Literal("text"), text: Type.String() });

const Body = Type.Object({
  model: Type.String(),
  messages: Type.Array(Type.Object({ role: Type.String(), content: Type.Unknown() })),
  system: Type.Array(TextBlock, { minItems: 1 }),
  tools: Type.Optional(Type.Array(Type.Unknown())),
  metadata: Type.Object({ user_id: Type.String() }),
  thread: Type.Optional(Type.Unknown()),
  diagnostics: Type.Optional(Type.Unknown()),
});

type Body = Static<typeof Body>;

/** How the installed CLI sends the second request of a prompt. */
export interface TurnFormat {
  /**
   * false means no message threads. With "billing", a continue keeps only the billing system block
   * and drops tools. With "full", a continue repeats the full system prompt and tools.
   */
  readonly threads: false | "billing" | "full";
  /** The billing header names the previous response's request-id. */
  readonly previousRequest: boolean;
  /** The request after a tool batch reports its tool durations. */
  readonly toolDurations: boolean;
}

export interface TurnContext {
  readonly signer: CliSignerConfig;
  readonly prefix: string;
  readonly profile: CliProfile;
  /** cc_version the CLI must send for `prompt`. */
  readonly version: (prompt: string) => string;
}

interface Parsed {
  readonly first: Body;
  readonly second: Body;
  readonly headers: readonly [Readonly<Record<string, string>>, Readonly<Record<string, string>>];
}

function changed(detail: string): Error {
  return new Error(`Claude CLI multi-request format changed (${detail}). Request blocked.`);
}

function parseRequest(request: TurnRequest, signer: CliSignerConfig): Body {
  const body: unknown = JSON.parse(request.rawBody);

  if (!Value.Check(Body, body)) {
    throw changed("request body");
  }

  if (!validateCliChecksum(request.rawBody, signer)) {
    throw changed("body signature");
  }

  if (JSON.stringify(Object.keys(body)) !== JSON.stringify(Object.keys(orderedBody(body)))) {
    throw changed("body key order");
  }

  return body;
}

function parse(capture: TurnCapture, signer: CliSignerConfig): Parsed {
  const [first, second] = capture.requests;

  if (capture.requests.length !== 2 || first === undefined || second === undefined) {
    throw changed("request count");
  }

  return {
    first: parseRequest(first, signer),
    second: parseRequest(second, signer),
    headers: [first.headers, second.headers],
  };
}

function billing(body: Body, prefix: string): Map<string, string> {
  return attributionFields(body.system[0]!.text, prefix);
}

function previousRequest(
  first: ReadonlyMap<string, string>,
  second: ReadonlyMap<string, string>,
  requestId: string,
): boolean {
  const sent = second.get("cc_prev_req");

  if (first.has("cc_prev_req") || (sent !== undefined && sent !== requestId)) {
    throw changed("cc_prev_req");
  }

  if (sent === undefined) {
    return false;
  }

  const expected = [...withPreviousRequest(first, requestId).keys()];

  if (!isRequestId(sent) || JSON.stringify([...second.keys()]) !== JSON.stringify(expected)) {
    throw changed("cc_prev_req position");
  }

  return true;
}

// Both requests answer one prompt, so the prompt and turn counters stay the same.
function assertBilling(parsed: Parsed, capture: TurnCapture, context: TurnContext): boolean {
  const first = billing(parsed.first, context.prefix);
  const second = billing(parsed.second, context.prefix);
  const base = attributionFields(context.profile.attributionText, context.prefix);

  for (const name of ["cc_version", "cc_prompt_id", "cc_prompt_index", "cc_turn_index"]) {
    if (first.get(name) === undefined || first.get(name) !== second.get(name)) {
      throw changed(name);
    }
  }

  if (
    first.get("cc_version") !== context.version(capture.prompt) ||
    JSON.stringify([...first.keys()]) !== JSON.stringify([...base.keys()]) ||
    first.get("cc_prompt_index") !== base.get("cc_prompt_index") ||
    first.get("cc_turn_index") !== base.get("cc_turn_index")
  ) {
    throw changed("billing header");
  }

  return previousRequest(first, second, capture.requestId);
}

function sendsThreadsBeta(parsed: Parsed): boolean {
  const [first, second] = parsed.headers.map((headers) =>
    hasBeta(headers["anthropic-beta"], threadsBetaPrefix),
  );

  if (first !== second) {
    throw changed("beta header");
  }

  return first === true;
}

function continueFields(parsed: Parsed): "billing" | "full" {
  const { first, second } = parsed;

  if (second.system.length === 1 && second.tools === undefined) {
    return "billing";
  }

  if (
    JSON.stringify(second.system.slice(1)) === JSON.stringify(first.system.slice(1)) &&
    second.tools !== undefined &&
    JSON.stringify(second.tools) === JSON.stringify(first.tools)
  ) {
    return "full";
  }

  throw changed("continued system or tools");
}

function threads(parsed: Parsed, capture: TurnCapture): TurnFormat["threads"] {
  const beta = sendsThreadsBeta(parsed);
  const { first, second } = parsed;

  if (first.thread === undefined && second.thread === undefined && !beta) {
    return false;
  }

  if (
    !beta ||
    !Value.Equal(first.thread, { type: "create" }) ||
    !Value.Equal(second.thread, { type: "continue", previous_message_id: capture.replyId }) ||
    first.metadata.user_id !== second.metadata.user_id
  ) {
    throw changed("continue request");
  }

  return continueFields(parsed);
}

function assertDiagnostics(parsed: Parsed, capture: TurnCapture, profile: CliProfile): void {
  const sent = parsed.first.diagnostics !== undefined || parsed.second.diagnostics !== undefined;

  if (
    sent !== profile.diagnostics ||
    (sent &&
      (!Value.Equal(parsed.first.diagnostics, { previous_message_id: null }) ||
        !Value.Equal(parsed.second.diagnostics, { previous_message_id: capture.replyId })))
  ) {
    throw changed("diagnostics");
  }
}

// Headers that may differ between the two requests of one prompt.
function variableHeader(
  name: string,
  first: string | undefined,
  second: string | undefined,
): boolean {
  return (
    name === toolDurationsHeader ||
    name === toolsUsedHeader ||
    (first !== undefined && second !== undefined && isUuid(first) && isUuid(second))
  );
}

function assertToolsUsed(parsed: Parsed, capture: TurnCapture, profile: CliProfile): void {
  const [first, second] = parsed.headers.map((headers) => headers[toolsUsedHeader]);

  if (first !== profile.headers[toolsUsedHeader]) {
    throw changed("tools used header");
  }

  if (
    first !== undefined &&
    (first !== toolsUsedValue([]) || second !== toolsUsedValue([capture.toolName]))
  ) {
    throw changed("tools used header");
  }
}

function toolDurations(parsed: Parsed, capture: TurnCapture): boolean {
  const [first, second] = parsed.headers;
  const names = new Set([...Object.keys(first), ...Object.keys(second)]);

  for (const name of names) {
    if (first[name] !== second[name] && !variableHeader(name, first[name], second[name])) {
      // Leaves out the header's name, because pi-ai reads an error that contains "thread" as a
      // thread rejection.
      throw changed("request headers");
    }
  }

  const durations = second[toolDurationsHeader];

  if (
    first[toolDurationsHeader] !== undefined ||
    (durations !== undefined && !new RegExp(`^${capture.toolName}=\\d+$`).test(durations))
  ) {
    throw changed("tool durations header");
  }

  return durations !== undefined;
}

export function readTurnFormat(capture: TurnCapture, context: TurnContext): TurnFormat {
  const parsed = parse(capture, context.signer);
  const previous = assertBilling(parsed, capture, context);

  assertDiagnostics(parsed, capture, context.profile);
  assertToolsUsed(parsed, capture, context.profile);

  return {
    threads: threads(parsed, capture),
    previousRequest: previous,
    toolDurations: toolDurations(parsed, capture),
  };
}
