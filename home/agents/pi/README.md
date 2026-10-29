# pi extensions

Extensions and a theme for [pi](https://pi.dev). `home/agents/default.nix` installs them into `~/.pi/agent`. `src/lib/` holds code they share.

## Patches

`patches/pi-review.patch` adds to [pi-review](https://github.com/earendil-works/pi-review):

- `/end-review` keeps the editor open and shows its progress. Esc cancels.
- `/review custom <prompt>`, or "Review with a custom prompt", reviews what you describe.
- `$name` in a custom prompt, custom instructions, or `--extra` loads that skill into the review.
- `super-review.ts` can add reviewers to `/review`.

`patches/pi-better-background-tasks.patch` applies [pi-better-harness#460](https://github.com/1aboveio/pi-better-harness/pull/460) to [pi-better-background-tasks](https://www.npmjs.com/package/pi-better-background-tasks). Without it, a subagent can hide this session's background tasks and their completion messages until `/reload`. Remove the patch once a release includes #460.

The build fails if either patch stops applying after an update.

## Configure

Extensions read their settings from `~/.pi/agent/settings.json`. Set them through `programs.pi-coding-agent.settings` in `home/agents/default.nix`, then run `/reload`. Missing keys use the defaults below. An unknown key or invalid value turns the extension off and shows an error. Activation doesn't delete old keys, so remove renamed keys by hand.

## Extensions

### `anthropic-billing.ts`

Sends pi's Anthropic OAuth requests with the same headers, system prompt, and body signature as the installed `claude --print`. This covers agent turns, compaction, cache warming, and extension calls such as `/btw`. It works only on macOS ARM64 and Linux x86-64.

It blocks a request it can't send that way. On non-Enterprise plans, it also blocks further requests once a response uses usage credits. Run `/reload` after updating `claude` or pi, or after switching accounts. No settings.

### `attention.ts`

Sends a notification when pi waits for you or finishes, unless you cancelled with Esc. In herdr, it shows pi as blocked while a question is open and notifies only for the active tab. In Rex, it also shows pi as blocked while an extension draws its own dialog, such as `ask_user_question` or pi-permission-system's prompt. pi reports its own dialogs, but leaves its state at working while an extension's dialog is open. `attention.ts` reports those as blocked on pi's own record, so Rex's tabs and session list show them. When the dialog closes, it writes pi's own state again.

It also tells the agent to ask with `ask_user_question` only for choices it can't make, and to recommend an option when it asks. The agent shows drafts instead of asking whether to apply them. It never ends a turn with a question in chat, because herdr shows that turn as done.

| Key                 | Default | Meaning                            |
| ------------------- | ------- | ---------------------------------- |
| `attention.title`   | `"pi"`  | Notification title                 |
| `attention.delayMs` | `1000`  | How long pi waits before notifying |

### `auto-mode.ts`

A model reviews pi-permission-system requests instead of asking you. Rules in `home/agents/default.nix` allow read-only tools, read-only commands, and writes inside the project without a review. The reviewer trusts your messages and your answers to `ask_user_question`, not the agent's tool calls or output.

When the reviewer denies a request, the agent takes the safer step if the reason names one. Otherwise it asks you with `ask_user_question` and retries once if you approve. A subagent stops and reports the denial to its parent instead. Errors and repeated denials open the permission dialog. So does a `path` or `external_directory` request that the reviewer doesn't deny.

| Key                                     | Default                                                          | Meaning                                                                  |
| --------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `autoMode.models`                       | `["openai/codex-auto-review", "openai-codex/codex-auto-review"]` | Reviewer models as `provider/id`. The first one with credentials reviews |
| `autoMode.reasoning`                    | `"low"`                                                          | Reasoning for the second stage                                           |
| `autoMode.firstStage`                   | `true`                                                           | Run the one-word first stage                                             |
| `autoMode.timeoutMs`                    | `30000`                                                          | Timeout for each model call, including its retries                       |
| `autoMode.maxRetries`                   | `3`                                                              | Retries per model call after a transient error                           |
| `autoMode.retryDelayMs`                 | `250`                                                            | Wait before the first retry                                              |
| `autoMode.maxRetryDelayMs`              | `2000`                                                           | Longest wait between retries                                             |
| `autoMode.maxDenials`                   | `3`                                                              | Denials in a row before asks go to the dialog until your next message    |
| `autoMode.environment`                  | `[]`                                                             | Organizations, domains, and services the reviewer trusts                 |
| `autoMode.context.messageTokens`        | `5000`                                                           | Limit per user message                                                   |
| `autoMode.context.toolCallTokens`       | `1000`                                                           | Limit per tool call                                                      |
| `autoMode.context.threadTokens`         | `30000`                                                          | Review thread size before it starts over                                 |
| `autoMode.investigation.maxCommands`    | `5`                                                              | Programs the assessment may run per review. `0` turns this off           |
| `autoMode.investigation.timeoutMs`      | `10000`                                                          | Timeout per program                                                      |
| `autoMode.investigation.totalTimeoutMs` | `60000`                                                          | Time for the whole second stage, checked before each model call          |
| `autoMode.investigation.outputTokens`   | `2000`                                                           | Output kept per program                                                  |

### `compaction.ts`

Writes the summaries for compaction, `/tree`, and `/end-review` from a fork of the session, so they see full tool results. It works with every provider. It also compacts at the end of a turn once context reaches `compactAt` of the model's window. If a fork for pi's own compaction or a `/tree` summary fails, pi's summarizer runs instead. If an end-of-turn fork fails, compaction waits for pi's own threshold.

The fork repeats the session's last request, so it reads the prompt cache and keeps settings other extensions add, such as `/fast`. Requests it can't repeat, such as Google's, go out as pi builds them and may miss the cache. So does the first fork after pi restarts. A notice after each fork shows how much of its input came from the cache.

| Key                     | Default | Meaning                                                      |
| ----------------------- | ------- | ------------------------------------------------------------ |
| `summaryFork.compactAt` | `0.9`   | Share of the model's context window that triggers compaction |

### `fast.ts`

`/fast` turns on fast mode for supported Anthropic models and the priority service tier for OpenAI. In the picker, enter applies it to this session and ctrl+s also saves it as the default. `--fast` starts with it on.

| Key                   | Default                                                   | Meaning                                         |
| --------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| `fast.models`         | `["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]` | Anthropic models that support fast mode         |
| `fast.beta`           | `"fast-mode-2026-02-01"`                                  | `anthropic-beta` header that enables it         |
| `fast.costMultiplier` | `2`                                                       | Price multiple for fast replies                 |
| `fastMode`            | `false`                                                   | Default on or off. `/fast` saves it with ctrl+s |

### `herdr-agents.ts`

In herdr, pi uses tools instead of the herdr CLI for most of what the herdr skill covers. pi doesn't get the herdr skill, but Claude Code and Codex still do. Remote machines (`herdr --machine`) aren't covered, because the tools watch agents on the local herdr server.

| Tool                    | What it does                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `herdr_start`           | Starts an agent in a new pane next to pi's, a new tab, or a git worktree, and can give it a first task. Focus stays where it is. |
| `herdr_worktree`        | Creates a git worktree through herdr, or opens an existing one by branch or path, for pi's own work such as reviewing a PR.      |
| `herdr_worktree_remove` | Removes a worktree through herdr and closes its workspace. Its branch is kept.                                                   |
| `herdr_watch`           | Prompts an agent or sends it keys. With only an agent, waits on one that's already working.                                      |
| `herdr_run`             | Runs a command in a new pane or tab you can watch. Can wait for a line of output, such as a server's ready message.              |
| `herdr_read`            | Shows an agent's state and recent output, or any pane's output, without blank lines and divider lines.                           |
| `herdr_agents`          | Lists the agents in herdr, with pi's own pane marked.                                                                            |
| `herdr_close`           | Closes an agent's or a command's pane.                                                                                           |
| `herdr_focus`           | Switches your herdr view to an agent, or to a pane's tab, when you ask to see it.                                                |

A prompt returns right away, and pi gets a message when the agent is done, idle, blocked, or failed, so it doesn't poll. If the agent doesn't start working within 5 seconds of a prompt, the message says so. Keys, such as Esc to interrupt, wait 2 seconds and return the agent's state and the last 20 lines of its screen. So does a prompt that starts with `/`, after up to 5 seconds for the agent to start working, because a command such as `/review` or `/new` can open a menu or finish without a turn. If the agent is working, pi also gets a message when it settles.

Worktrees go in herdr's worktree directory. Each opens in its own workspace, in the space of the repository's main checkout, so it shows up in herdr. pi can start from any directory in the repository, including another worktree, and a new branch starts from the commit there unless `base` says otherwise. If the branch already has a worktree, the tools reuse it. When its workspace is already open, `herdr_start` opens a new tab there rather than taking the first pane, which may be in use. Removing a worktree ends anything running in its workspace. herdr refuses one with uncommitted changes unless pi passes `force`, which it does only when you say to. pi removes a worktree it made once its work is committed and done, or when you ask. It won't remove the main checkout or the worktree it runs in.

A Herdr block above the editor lists the agents pi is waiting on, with each one's state and the time since the prompt. If pi stops watching an agent first, for example because the agent exits, the message says so. No settings.

### `rex.ts`

In [Rex](https://www.superlogical.com/rex), pi uses tools instead of the rex CLI to run agents and commands in panes. pi doesn't get the Rex skill, but Claude Code and Codex still do. pi gets either these tools or herdr's, from the nearest herdr or Rex server in its process ancestry. Panes inherit environment variables such as `HERDR_ENV` from whatever started the multiplexer, so pi can't rely on them. `attention.ts` checks the same way.

| Tool                  | What it does                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `rex_start`           | Starts an agent in a new pane next to pi's, a new tab, another session or a new one, or a git worktree's tab, and can give it a first task. |
| `rex_worktree`        | Creates a git worktree in its own tab, or opens an existing one by branch or path, for pi's own work such as reviewing a PR.                |
| `rex_worktree_remove` | Removes a worktree and closes its tabs. Its branch is kept.                                                                                 |
| `rex_watch`           | Prompts an agent or sends it keys. With only an agent, waits on one that's already working.                                                 |
| `rex_run`             | Runs a command in a new pane or tab you can watch, in any session. Can wait for a line of output, such as a ready message.                  |
| `rex_read`            | Shows an agent's state and recent output, or any pane's output, without blank lines and divider lines.                                      |
| `rex_agents`          | Lists the agents in every Rex session, under their session and tab, with pi's own pane and worktree tabs marked.                            |
| `rex_close`           | Closes an agent's or a command's pane.                                                                                                      |
| `rex_focus`           | Switches your Rex view to an agent's or a command's pane, when you ask to see it.                                                           |

An agent is any program that reports its state to Rex with the [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status), as pi, Claude Code, and Codex do. Its name is its pane's label. The tools follow the session's events from `rex events`, so pi gets a message when an agent is done, idle, blocked, or failed, the same way as in herdr, and doesn't poll. An agent counts as blocked while any of its records is, so pi gets a message when a pi agent waits on a permission prompt. `rex_start` runs the agent as its pane's command, so the pane closes when the agent exits. `rex_run` types its command into a shell, so your shell setup, such as direnv, applies.

The tools reach every session. A bare name means a pane in pi's own session if one has it, then one in any session. `session/name` picks the session, and a block ID always works. `rex_start`, `rex_run`, and `rex_worktree` take `session` to open in another session, and the first two take `tab` to split the focused pane of a tab other than pi's. A split in another session always goes right, because a session no app shows reports its panes as 80x24. `rex_focus` switches the app to another session only with Remote Control on in the app's settings under Rex Server. Otherwise it focuses the pane and fails with an error that says so.

A `session` label that no session has creates that session. The new pane is alone in the session's first tab. The tab takes the pane's name, if it has one. For a worktree, the session starts with a shell that closes once the worktree's tab opens. If the worktree's tab is already open in another session, pi uses that tab and kills the new session. If the pane fails to start, pi kills the session it made too, unless another pane is there. A split into a session with no panes, such as one whose last agent exited, opens a tab there instead.

Rex has no worktrees of its own, so [`home/agents/rex/worktree.lua`](../rex/worktree.lua) adds them, and the tools run it with `rex do`. A worktree tab is a tab it opened for a worktree, labelled `⎇ branch`. Rex keeps nothing on a tab, so it records each one in `~/.local/state/rex/worktrees.json`, under a lock so parallel calls don't lose entries. New worktrees go in `<directory>/<repository>/<branch>`, where `directory` comes from `~/.config/rex/worktree.json`. `home/agents/default.nix` sets it to `~/Developer/.rex/worktrees`, next to herdr's.

pi can start from any directory in the repository, including another worktree, and a new branch starts from the commit there unless `base` says otherwise. A branch that only a remote has, such as a PR's, gets a local branch that tracks it. If the branch already has a worktree, the tools reuse it, and when its tab is open, `rex_start` splits that tab.

Removing a worktree closes its tabs, which ends anything running there. It refuses one with uncommitted changes unless pi passes `force`, which it does only when you say to. pi removes a worktree it made once its work is committed and done, or when you ask. It won't remove the main checkout, or the worktree or tab it runs in.

The same file gives Rex's command palette a Worktrees category, which Claude Code and Codex can also run with `rex do`:

| Action                    | What it does                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `worktree_pick`           | **Worktrees…** opens fzf over the focused pane's repository. Enter opens one, a new name makes it, and ctrl-x removes one. |
| `worktree_remove_current` | **Remove This Tab's Worktree** removes the active tab's worktree and closes the tab.                                       |
| `worktree_open`           | Opens a worktree by `branch` or `path`, making it first if needed. Takes `session`, `command`, `label`, and `focus`.       |
| `worktree_remove`         | Removes a worktree by `branch` or `path`, with `force` to discard changes.                                                 |
| `worktree_list`           | Lists the repository's worktrees and the tabs they're open in.                                                             |

Actions in the configuration get 30 seconds, so a big repository's `git worktree add` can time out from the palette. The picker and the tools run the file as a script, which Rex doesn't time out.

### `rex-resume.ts`

Tells Rex which session pi runs in its pane, so [`home/agents/rex/agent_resume.lua`](../rex/agent_resume.lua) can resume it with `pi --session <file>` after the Rex server restarts. Rex brings panes back as new shells. It can't see which session a program had, so each session start writes `{agent, session, file, cwd, pid}` to `~/.local/state/rex/agents/<block>`. Claude Code and Codex write the same record from a SessionStart hook, [`home/agents/rex-session-hook.sh`](../rex-session-hook.sh), and resume with `claude --resume <id>` and `codex resume <id>`.

`agent_resume.lua` does the rest. `init.lua` starts it as a script that follows every session. It deletes a record once the agent has exited and its pane is back at its shell's prompt, which means you quit the agent. An agent suspended with Ctrl+Z keeps its record. It also deletes the records of closed panes. When the server shuts down, the shell dies with the agent, so the record stays. When the script finds a new server instance, it types each record's command into its pane once the pane is back at a shell. The command joins `cd` and the agent with `&&`, so Nushell panes aren't resumed. A session with no messages yet starts fresh. If a resumed agent hasn't started a minute later, the script deletes its record.

Subagents, print runs such as `claude -p` or `codex exec`, and agents running inside another agent's processes don't write a record. An agent that another agent starts in a pane of its own, as `rex_start` does, owns that pane and does. `rex-resume.ts` has no settings.

### `mcp-ancestors.ts`

Loads MCP servers from the `.mcp.json` in each folder from a configured root down to the session's folder, as Claude Code does. Nearer files win, and `~/.pi/agent/mcp.json` wins over all of them. It expands `${VAR}` and `${VAR:-default}` in them. Untrusted projects load none.

| Key                  | Default | Meaning                                                       |
| -------------------- | ------- | ------------------------------------------------------------- |
| `mcpAncestors.roots` | `[]`    | Root folders. The deepest one that contains the session wins. |

### `mermaid.ts`

Draws mermaid diagrams with [lovely-mermaid](https://github.com/xl0/lovely-mermaid), which handles more syntax than pi's built-in renderer. `home/agents/default.nix` turns pi's renderer off. It redraws wide flowcharts top to bottom. A diagram that fails shows its source and the error. It tells the agent which diagram types draw and how long labels can be. No settings.

### `prompt-sections.ts`

Keeps the prompt cache working when other extensions add text to the system prompt. Without it, pi resends the whole prompt after each change. It has to run after those extensions, so `home/agents/default.nix` lists it last in `packages`. No settings.

### `skill-mention.ts`

`$name` anywhere in a prompt loads that skill. pi's `/skill:name` works only at the start of a prompt. Other extensions can offer the same `$name` completion and loading in their own prompts, as pi-review's custom prompt does. No settings.

### `statusline.ts`

Replaces pi's footer with a line of segments. Statuses from other extensions go on a second line when there are any. The `talk`, `autoMode`, and `fast` segments show those extensions' statuses, so leaving a segment out hides its status. `tokens` shows input (`↑`) and output (`↓`) tokens since your last message, with `~` while output is an estimate. If the settings are invalid, pi keeps its own footer.

| Key                   | Default                  | Meaning                                                                                                                         |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `statusline.segments` | all, in the order listed | Segments to show, in order. Any of `talk`, `autoMode`, `model`, `thinking`, `fast`, `cwd`, `context`, `cost`, `tokens`, `speed` |

### `super-review.ts`

Adds reviewers on other models to pi-review's `/review`. You pick the models after pi-review's dialogs. For an Anthropic session it suggests `openai/gpt-6-astra`, or `openai-codex/gpt-6-astra` if only Codex is logged in. For an OpenAI session it suggests `anthropic/claude-opus-5-5`.

Each reviewer reviews the same change. The session's model compares their findings and runs discussion rounds. After the round limit, it drops findings still in dispute and gives each finding whose priority is in dispute the lowest priority proposed. It prints the final review once the reviewers confirm it.

| Key                                  | Default | Meaning                                                                                                   |
| ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| `superReview.adversaries.<provider>` | none    | Models for the "Adversaries" option, as `{ "model", "thinking" }`. ctrl+s in the custom picker saves them |
| `superReview.rounds`                 | `3`     | Rounds before the deadlock rule, multiplied by the number of adversaries                                  |

### `talk.ts`

`/talk` or shift+tab turns read-only talk mode on and off. It blocks `talk.blockedTools` and adds `talk.prompt` as a `talk_mode` system prompt section. On models that accept system messages mid-conversation, pi sends one system message each time the mode turns on or off. On other models, each toggle misses the prompt cache. Each branch keeps its own setting, including after `/tree`. Bash stays available for research. `--talk` starts with it on.

| Key                 | Default             | Meaning                                            |
| ------------------- | ------------------- | -------------------------------------------------- |
| `talk.prompt`       | none, required      | Prompt section text. nix sets it from `talkPrompt` |
| `talk.blockedTools` | `["edit", "write"]` | Tools blocked in talk mode                         |
