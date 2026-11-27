# pi extensions

Extensions, patches, and a theme for [pi](https://pi.dev). `home/agents/default.nix` installs them into `~/.pi/agent`. `src/lib/` holds code the extensions share.

## Configure

Extensions read their settings from `~/.pi/agent/settings.json`. Set them in `programs.pi-coding-agent.settings` in `home/agents/default.nix`, then run `/reload`. Missing keys use the defaults below. An unknown key or invalid value turns the extension off and shows an error. Activation doesn't delete old keys, so remove renamed keys by hand.

## ChatGPT plan

Run `/login openai-codex`, then select `openai-codex/gpt-6.2-sol` in `/model`.

## Patches

The patches in `patches/` change other packages. The build fails if a patch stops applying after an update.

- `pi-review.patch` changes [pi-review](https://github.com/earendil-works/pi-review):
  - `/end-review` keeps the editor open and shows its progress. Esc cancels.
  - `/review custom <prompt>`, or "Review with a custom prompt", reviews what you describe.
  - `$name` in a custom prompt, custom instructions, or `--extra` loads that skill.
  - `super-review.ts` can add reviewers to `/review`.
- `pi-subagents.patch` changes [pi-subagents](https://www.npmjs.com/package/@gotgenes/pi-subagents):
  - Explore runs on the newest Haiku.
  - A fuzzy model name, such as `sonnet`, picks the newest match.
- `pi-permission-system.patch` lets `auto-mode.ts` allow requests outside the project.
- `mcp-spill.js` saves an MCP reply too large for pi to a file. The call fails with the file's path.

## Extensions

### `anthropic-billing.ts`

Sends pi's Anthropic OAuth requests the way the installed `claude --print` sends them, with the same headers, system prompt, and body signature. This covers agent turns, compaction, cache warming, and extension calls such as `/btw`. Works only on macOS ARM64 and Linux x86-64.

- It runs `claude` against a local mock to learn its requests.
- It blocks a request it can't send that way.
- On non-Enterprise plans, it blocks further requests once a response uses usage credits.
- It adds the models in the account's Claude Code model catalog. Accounts in the Cyber Verification Program get Claude Mythos.
- A model with a catalog badge, such as `CVP: Defense Access`, shows the badge after its name in `/model` and in the statusline.

The catalog is saved in `~/.pi/agent/extensions/anthropic-billing/model-catalog.json`. pi refreshes it at most once an hour, and not with `--offline`. While the catalog adds or renames a model, pi's Anthropic models skip pi.dev's catalog updates.

Run `/reload` after updating `claude` or pi, or after switching accounts. No settings.

### `attention.ts`

Notifies you when pi waits for you or finishes, unless you pressed Esc. In herdr and Rex, it shows pi as blocked while a question or an extension's dialog is open. In Rex, pi stays working while background tasks or subagents it waits on run.

It also tells the agent to ask with `ask_user_question` only for choices it can't make, and never to end a turn with a question in chat.

Start a task that never ends, such as a dev server, with `callback: false`. Otherwise pi stays working.

| Key                 | Default | Meaning                            |
| ------------------- | ------- | ---------------------------------- |
| `attention.title`   | `"pi"`  | Notification title                 |
| `attention.delayMs` | `1000`  | How long pi waits before notifying |

### `auto-mode.ts`

A reviewer model answers pi-permission-system requests instead of you. Rules in `home/agents/default.nix` allow read-only tools, read-only commands, and writes inside the project without a review. The reviewer trusts your messages and your answers to `ask_user_question`, not the agent's tool calls or output.

When the reviewer denies a request, the agent takes the safer step the reviewer names, or asks you and retries once if you approve. Errors, and some requests outside the project, open the permission dialog. After `autoMode.maxDenials` denials in a row, each further denial opens the dialog too.

| Key                                     | Default                                                          | Meaning                                                                  |
| --------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `autoMode.models`                       | `["openai-codex/codex-auto-review", "openai/codex-auto-review"]` | Reviewer models as `provider/id`. The first one with credentials reviews |
| `autoMode.reasoning`                    | `"low"`                                                          | Reasoning for the second stage                                           |
| `autoMode.firstStage`                   | `true`                                                           | Run the one-word first stage                                             |
| `autoMode.timeoutMs`                    | `30000`                                                          | Timeout for each model call, including its retries                       |
| `autoMode.maxRetries`                   | `3`                                                              | Retries per model call after a transient error                           |
| `autoMode.retryDelayMs`                 | `250`                                                            | Wait before the first retry                                              |
| `autoMode.maxRetryDelayMs`              | `2000`                                                           | Longest wait between retries                                             |
| `autoMode.maxDenials`                   | `3`                                                              | Denials in a row before further denials open the dialog                  |
| `autoMode.environment`                  | `[]`                                                             | Organizations, domains, and services the reviewer trusts                 |
| `autoMode.context.messageTokens`        | `5000`                                                           | Limit per user message                                                   |
| `autoMode.context.toolCallTokens`       | `1000`                                                           | Limit per tool call                                                      |
| `autoMode.context.threadTokens`         | `30000`                                                          | Review thread size before it starts over                                 |
| `autoMode.investigation.maxCommands`    | `5`                                                              | Programs the assessment may run per review. `0` turns this off           |
| `autoMode.investigation.timeoutMs`      | `10000`                                                          | Timeout per program                                                      |
| `autoMode.investigation.totalTimeoutMs` | `60000`                                                          | Time for the whole second stage, checked before each model call          |
| `autoMode.investigation.outputTokens`   | `2000`                                                           | Output kept per program                                                  |

### `compaction.ts`

Writes the summaries for compaction, `/tree`, and `/end-review` from a fork of the session. The summary sees full tool results and reads the prompt cache. If a fork fails, pi's own summarizer runs. It also:

- compacts at the end of a turn once context reaches `summaryFork.compactAt` of the model's window.
- leaves out the thinking blocks Anthropic would drop after a compaction.
- keeps an idle session's one-hour cache warm for `summaryFork.idle.warmMinutes`, then compacts the session while the cache is still warm.
- compacts a large session that sat idle, such as after sleep or a restart, before your next prompt. This costs less than writing its whole context to the cache again.

Cache refreshes need pi running and the machine awake. Each one is a `cache-refresh` entry in the session, and the statusline's cost includes it.

| Key                            | Default  | Meaning                                                                                                                |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `summaryFork.compactAt`        | `0.9`    | Share of the model's context window that triggers compaction                                                           |
| `summaryFork.idle.minTokens`   | `150000` | Smallest context of an idle session that the extension acts on. `/fast` uses it too                                    |
| `summaryFork.idle.warmMinutes` | `240`    | How long to refresh an idle session's cache. `0` never refreshes it                                                    |
| `summaryFork.idle.compact`     | `true`   | Compact the session when the refreshes stop, or on the next prompt if they couldn't run. `false` lets the cache expire |

### `fast.ts`

Sets the current model's speed: `off`, `fast`, or `ultrafast`.

- `/fast` opens a picker. Enter sets the speed for this session. Ctrl+S saves it as the model's default.
- `/fast on`, `/fast ultrafast`, and `/fast off` set the speed for this session without the picker.
- `--fast` and `--ultrafast` start pi at that speed.

Fast turns on Anthropic's fast mode and OpenAI's priority tier. Ultrafast uses OpenAI's ultrafast tier on the models in `fast.ultrafastModels`, and fast on other models. On `openai-codex`, pi requests only the tiers the account's Codex catalog lists.

A speed change makes the next request write the whole context to the cache again. On a large idle session, the picker offers to compact first and shows what each choice costs.

| Key                            | Default                                                        | Meaning                                                                                     |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `fast.models`                  | `["claude-fable-5-2", "claude-mythos-5-2", "claude-opus-5-5"]` | Anthropic models that support fast mode                                                     |
| `fast.beta`                    | `"fast-mode-2026-02-01"`                                       | `anthropic-beta` header that enables it                                                     |
| `fast.costMultiplier`          | `2`                                                            | Price multiple for Anthropic fast replies                                                   |
| `fast.ultrafastModels`         | `["gpt-6.2-astra", "gpt-6.2-sol"]`                             | `openai` models that support ultrafast                                                      |
| `fast.ultrafastCostMultiplier` | `6`                                                            | Price multiple for ultrafast OpenAI replies                                                 |
| `fastMode`                     | `{}`                                                           | Default speed by `provider/id`: `"fast"` or `"ultrafast"`. A missing model defaults to off. |

### `herdr-agents.ts`

In herdr, gives pi tools to run agents and commands in panes, in place of the herdr CLI and skill. Claude Code and Codex keep the herdr skill. The tools work only with the local herdr server, not `herdr --machine`.

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

- After a prompt, pi gets a message when the agent is done, idle, blocked, or failed, so it doesn't poll.
- Keys and prompts that start with `/` return the agent's state and screen.
- A Herdr block above the editor lists the agents pi is waiting on.
- Worktrees go in herdr's worktree directory, each in its own workspace. pi removes a worktree it made once the work is committed, and discards changes only when you say to.

No settings.

### `rex.ts`

In [Rex](https://www.superlogical.com/rex), gives pi tools to run agents and commands in panes, in place of the rex CLI and skill. Claude Code and Codex keep the Rex skill. pi gets these tools or herdr's, from whichever server it runs under.

| Tool                  | What it does                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `rex_start`           | Starts an agent in a new pane next to pi's, a new tab, another session or a new one, or a git worktree's tab, and can give it a first task. |
| `rex_worktree`        | Creates or opens a git worktree in its own tab, so pi can read a branch, such as a PR's. pi changes a worktree with `rex_start`.            |
| `rex_worktree_remove` | Removes a worktree and closes its tabs. Its branch is kept.                                                                                 |
| `rex_watch`           | Prompts an agent or sends it keys. With only an agent, waits on one that's already working.                                                 |
| `rex_run`             | Runs a command in a new pane or tab you can watch, in any session. Can wait for a line of output, such as a ready message.                  |
| `rex_read`            | Shows an agent's state and recent output, or any pane's output, without blank lines and divider lines.                                      |
| `rex_agents`          | Lists the agents in every Rex session, under their session and tab, with pi's own pane and worktree tabs marked.                            |
| `rex_close`           | Closes an agent's or a command's pane.                                                                                                      |
| `rex_focus`           | Switches your Rex view to an agent's or a command's pane, when you ask to see it.                                                           |

- An agent is any program that reports its state with Rex's [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status), such as pi, Claude Code, and Codex. Its name is its pane's label.
- After a prompt, pi gets a message when the agent is done, idle, blocked, or failed, as in herdr.
- The tools reach every session. Name another session's pane as `session/name` or by block ID. A `session` label that no session has creates that session.
- `rex_focus` switches to another session only with Remote Control on in the Rex app's settings.
- `rex_start` runs the agent as the pane's command, so the pane closes when the agent exits. `rex_run` types its command into a shell, so your shell setup, such as direnv, applies.

Rex has no worktrees, so [`home/agents/rex/worktree.lua`](../rex/worktree.lua) adds them. New worktrees go in `<directory>/<repository>/<branch>`. `directory` comes from `~/.config/rex/worktree.json`, which `home/agents/default.nix` sets to `~/Developer/.rex/worktrees`. The file also adds a Worktrees category to Rex's command palette. Run the actions outside the palette with `rex do ~/.config/rex/worktree.lua --action NAME`.

| Action                    | What it does                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktree_open`           | **Worktrees…** picks a worktree of the focused pane's repository with fzf. Enter opens it, a new name creates it, ctrl-x removes it. With `branch` or `path`, it opens that worktree and creates it if needed. |
| `worktree_remove_current` | **Remove This Tab's Worktree** removes the active tab's worktree and closes the tab.                                                                                                                           |
| `worktree_remove`         | Removes a worktree by `branch` or `path`, with `force` to discard changes. Not in the palette.                                                                                                                 |
| `worktree_list`           | Lists the repository's worktrees and the tabs they're open in. Not in the palette.                                                                                                                             |

Rex stops other palette actions after 30 seconds. **Worktrees…** and the tools run as scripts, which Rex doesn't stop.

### `rex-resume.ts`

Resumes pi sessions in their panes after the Rex server restarts. Claude Code and Codex sessions resume too, through [`home/agents/rex-session-hook.sh`](../rex-session-hook.sh). Each agent records its session in `~/.local/state/rex/agents/<block>`, and [`home/agents/rex/agent_resume.lua`](../rex/agent_resume.lua) runs the resume command once the pane is back at a shell.

Quitting an agent deletes its record. Subagents, print runs such as `claude -p`, and Nushell panes aren't resumed. No settings.

### `mcp-ancestors.ts`

Loads MCP servers from the `.mcp.json` in each folder from a configured root down to the session's folder, as Claude Code does. Nearer files win, and `~/.pi/agent/mcp.json` wins over all of them. `${VAR}` and `${VAR:-default}` expand. Untrusted projects load none.

| Key                  | Default | Meaning                                                       |
| -------------------- | ------- | ------------------------------------------------------------- |
| `mcpAncestors.roots` | `[]`    | Root folders. The deepest one that contains the session wins. |

### `prompt-sections.ts`

Keeps the prompt cache working when other extensions add to the system prompt. It must run after them, so `home/agents/default.nix` lists it last in `packages`. No settings.

### `skill-mention.ts`

`$name` anywhere in a prompt loads that skill. pi's own `/skill:name` works only at the start of a prompt. No settings.

### `statusline.ts`

Replaces pi's footer with one line of segments. Other extensions' statuses go on a second line. If the settings are invalid, pi keeps its own footer.

- `talk`, `autoMode`, and `fast` show those extensions' statuses. Leaving one out hides its status.
- `cvp` shows the selected Anthropic model's catalog badge, such as `CVP: Defense Access`.
- `tokens` shows `↑` input and `↓` output tokens since your last message, with `~` while output is an estimate.
- `cost` shows the session's cost. On a subscription it adds the plan, such as `$0.00 (pro 200)`.
  - `openai-codex`: `free`, `go`, `plus`, `pro 100`, `pro 200`, `pro 500`, `business`, or `enterprise`, from the login's access token.
  - `anthropic`: `pro`, `max`, `ultra`, `team`, or `enterprise`, from `claude auth status`. This is the Claude CLI's login, not pi's.
  - Any other plan shows its raw name, such as `edu_plus`.
  - After `/login`, the new plan shows on the next model selection.
  - `(sub)` stands in for the plan while it loads, with `--offline`, and when the lookup fails or isn't possible. A failed lookup also shows a warning.

| Key                   | Default                  | Meaning                                                                                                                                |
| --------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `statusline.segments` | all, in the order listed | Segments to show, in order. Any of `talk`, `autoMode`, `model`, `thinking`, `fast`, `cvp`, `cwd`, `context`, `cost`, `tokens`, `speed` |

### `super-review.ts`

Adds reviewers on other models to pi-review's `/review`. You pick the models after pi-review's dialogs. An Anthropic session suggests `openai-codex/gpt-6.2-astra`, and an OpenAI session suggests `anthropic/claude-fable-5-2`.

The reviewers review the same change, and the session's model settles their findings over discussion rounds. After the last round, it drops disputed findings and gives each disputed priority the lowest one proposed.

| Key                                  | Default | Meaning                                                                                                   |
| ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| `superReview.adversaries.<provider>` | none    | Models for the "Adversaries" option, as `{ "model", "thinking" }`. ctrl+s in the custom picker saves them |
| `superReview.rounds`                 | `3`     | Rounds before the deadlock rule, multiplied by the number of adversaries                                  |

### `talk.ts`

Read-only talk mode. `/talk` or shift+tab turns it on and off, and `--talk` starts pi with it on. It blocks `talk.blockedTools` and adds `talk.prompt` to the system prompt. Bash stays available for research. Each branch keeps its own setting. On models without mid-conversation system messages, each toggle misses the prompt cache.

| Key                 | Default             | Meaning                                            |
| ------------------- | ------------------- | -------------------------------------------------- |
| `talk.prompt`       | none, required      | Prompt section text. nix sets it from `talkPrompt` |
| `talk.blockedTools` | `["edit", "write"]` | Tools blocked in talk mode                         |
