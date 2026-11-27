import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const runFile = promisify(execFile);

const Optional = Type.Optional(Type.Union([Type.String(), Type.Null()]));

const AuthStatus = Type.Object({
  loggedIn: Type.Boolean(),
  authMethod: Optional,
  subscriptionType: Optional,
});

export type ClaudeAuthStatus = Static<typeof AuthStatus>;

// The CLI prints its status, then exits with 1 when logged out.
const LoggedOutExit = Type.Object({ code: Type.Literal(1), stdout: Type.String() });

function parseStatus(stdout: string): ClaudeAuthStatus {
  let status: unknown;

  try {
    status = JSON.parse(stdout);
  } catch (cause) {
    // The parser's message can quote the output, which holds the account's email.
    throw new Error("claude auth status printed invalid JSON", { cause });
  }

  if (!Value.Check(AuthStatus, status)) {
    throw new Error("claude auth status --json format changed");
  }

  return status;
}

// The status a failed run printed, if it says the CLI is logged out.
function loggedOutStatus(error: Error): ClaudeAuthStatus | undefined {
  if (!Value.Check(LoggedOutExit, error)) {
    return undefined;
  }

  try {
    const status = parseStatus(error.stdout);

    return status.loggedIn ? undefined : status;
  } catch {
    // Other output means another failure. The caller rethrows its error.
    return undefined;
  }
}

export async function readClaudeAuthStatus(executable: string): Promise<ClaudeAuthStatus> {
  let stdout: string;

  try {
    ({ stdout } = await runFile(executable, ["auth", "status", "--json"], {
      timeout: 5000,
      maxBuffer: 65_536,
    }));
  } catch (error) {
    const status = error instanceof Error ? loggedOutStatus(error) : undefined;

    if (status === undefined) {
      throw error;
    }

    return status;
  }

  return parseStatus(stdout);
}
