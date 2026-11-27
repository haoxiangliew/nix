import type { Static, TSchema } from "typebox";

import { Type } from "typebox";
import { Value } from "typebox/value";

const AUTH_CLAIM = "https://api.openai.com/auth";

const Claims = Type.Object({ [AUTH_CLAIM]: Type.Object({}) });

/**
 * Returns the ChatGPT claim in an openai-codex access token. `schema` lists the fields the caller
 * needs. When the claim doesn't match it, the error names `missing`.
 */
export function chatgptClaim<S extends TSchema>(
  token: string,
  schema: S,
  missing: string,
): Static<S> {
  const [, payload] = token.split(".");

  if (payload === undefined) {
    throw new Error("The openai-codex access token isn't a JWT");
  }

  let claims: unknown;

  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch (cause) {
    // The parser's message can quote the payload, which holds account details.
    throw new Error("The openai-codex access token has an unreadable payload", { cause });
  }

  if (!Value.Check(Claims, claims)) {
    throw new Error("The openai-codex access token has no ChatGPT claim");
  }

  const claim = claims[AUTH_CLAIM];

  if (!Value.Check(schema, claim)) {
    throw new Error(`The openai-codex access token has no ${missing}`);
  }

  return claim;
}
