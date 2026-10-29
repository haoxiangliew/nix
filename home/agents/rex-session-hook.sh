# shellcheck shell=bash

# A SessionStart hook that tells Rex which session Claude Code or Codex, named by $1, runs in its
# pane, so rex/agent_resume.lua can resume it after the Rex server restarts. pi does the same in
# pi/src/rex-resume.ts.
#
# Every process in a Rex pane inherits REX_BLOCK, so the hook writes the record only for the agent
# that owns the pane: Rex is its nearest multiplexer, no other agent runs it, and it isn't a print
# run such as `claude -p` or `codex exec`. It also skips subagents. Claude Code's have an agent_id,
# and a Codex subagent inherits its parent's CODEX_THREAD_ID.

agent=$1

[ -n "${REX_BLOCK:-}" ] || exit 0

# Claude Code sets this to sdk-cli for a print run.
if [ "$agent" = claude ] && [ "${CLAUDE_CODE_ENTRYPOINT:-}" != cli ]; then
  exit 0
fi

# Codex's global options that take a value, which comes before its subcommand.
codex_valued=" -c --config --enable --disable --remote --remote-auth-token-env -i --image -m --model 
  --local-provider -p --profile -s --sandbox -C --cd --add-dir -a --ask-for-approval "

# Whether a word is a Codex subcommand that doesn't start an interactive session. resume and fork
# do, and a bare word that isn't a subcommand is a prompt.
codex_batch() {
  case $1 in
  agents | exec | e | review | login | logout | mcp | plugin | app-server | remote-control | app) ;;
  completion | update | doctor | sandbox | debug | apply | a | queue | archive | delete) ;;
  migrate-rollouts | migrate-nfs-db | unarchive | cloud | exec-server | features | help) ;;
  *) return 1 ;;
  esac
}

# Prints Codex's first word that isn't an option or an option's value. ps joins the arguments with
# spaces, so a value with a space in it throws this off.
codex_subcommand() {
  local skip="" word

  for word in "$@"; do
    if [ -n "$skip" ]; then
      skip=""
    elif [[ $word != -* ]]; then
      echo "$word"
      return
    elif [[ $word != *=* && $codex_valued == *" $word "* ]]; then
      skip=1
    fi
  done
}

# Walks up from the hook's parent. The first process named for the agent is the agent.
owner=""
pid=$PPID

while [ "$pid" -gt 1 ]; do
  read -r parent comm <<<"$(ps -o ppid=,comm= -p "$pid")"
  args=$(ps -o args= -p "$pid")
  argv0=${args%% *}
  argv0=${argv0##*/}

  case ${comm##*/} in
  rex) break ;;
  herdr) exit 0 ;;
  esac

  case $argv0 in
  pi | claude | codex)
    if [ -n "$owner" ] || [ "$argv0" != "$agent" ]; then
      exit 0
    fi

    owner=$pid
    read -ra words <<<"$args"

    if [ "$agent" = codex ] && codex_batch "$(codex_subcommand "${words[@]:1}")"; then
      exit 0
    fi
    ;;
  esac

  pid=$parent
done

if [ "$pid" -le 1 ] || [ -z "$owner" ]; then
  exit 0
fi

records="${XDG_STATE_HOME:-$HOME/.local/state}/rex/agents"
record="$records/${REX_BLOCK#block:}"
mkdir -p "$records"

# jq -e exits 4 when select leaves nothing, which is a session to skip.
status=0
jq -ce --arg agent "$agent" --argjson pid "$owner" --arg thread "${CODEX_THREAD_ID:-}" '
  select(.agent_id == null and (.session_id | type) == "string")
  | select($thread == "" or $thread == .session_id)
  | {agent: $agent, session: .session_id, file: .transcript_path, cwd: (.cwd // env.PWD), pid: $pid}
' >"$record.$$.tmp" || status=$?

case $status in
0) mv -f "$record.$$.tmp" "$record" ;;
4) rm -f "$record.$$.tmp" ;;
*)
  rm -f "$record.$$.tmp"
  exit "$status"
  ;;
esac
