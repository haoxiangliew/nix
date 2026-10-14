# pi extensions

This folder has extensions and a theme for [pi](https://pi.dev). `home/agents/default.nix` links them into `~/.pi/agent`. `src/lib/` has code the extensions share.

## Patches

`patches/pi-review.patch` makes [pi-review](https://github.com/earendil-works/pi-review)'s `/end-review` keep the editor open while it summarizes, so dialogs from other extensions stay visible. It also shows progress in a widget and lets Esc cancel. It adds a "Review with a custom prompt" option and `/review custom <prompt>`, where you describe what to review. And it emits each `/review` prompt on `pi.events` as `review:prompt` for `super-review.ts`. The build fails if the patch stops applying after `nix flake update pi-review`.

## Configure

Each extension reads a top-level key in `~/.pi/agent/settings.json`. `home/agents/default.nix` sets these keys from `programs.pi-coding-agent.settings`. Missing fields use the defaults below, and `/reload` picks up changes. An unknown key or invalid value turns the extension off with an error. Activation never deletes keys, so remove renamed ones by hand.

### `anthropic-billing.ts`

Sends pi's Anthropic OAuth requests with the headers, system prompt, and body signature of the installed `claude --print`. This includes compaction forks and cache warming. It learns them by running `claude` against a local mock API and reading its binary. This works only on macOS ARM64 and Linux x86-64. It blocks any request it can't match. On plans other than Enterprise, it also blocks the session once Anthropic bills a response to usage credits. Run `/reload` after updating `claude` or pi, or after switching accounts. No settings.

### `attention.ts`

Notifies when pi waits on a prompt or finishes, but not when you cancel with Esc. In herdr it marks prompts as blocked and only notifies for the active tab. It also tells the agent to ask for decisions with `ask_user_question`, since herdr shows a turn that ends on a question as done.

| Key                 | Default | Meaning                            |
| ------------------- | ------- | ---------------------------------- |
| `attention.title`   | `"pi"`  | Notification title                 |
| `attention.delayMs` | `1000`  | How long pi waits before notifying |

### `auto-mode.ts`

Reviews pi-permission-system asks with a model instead of asking you. The static rules in `home/agents/default.nix` allow only what's safe without review, and every other ask comes here. The reviewer trusts your messages and your answers to `ask_user_question`, never the agent's tool calls or output. Before it allows or denies an ask, it can run checks limited to what the agent may run without asking. It can deny `path` and `external_directory` asks, such as writes outside the project. When it would allow one, it opens the dialog instead. Errors and repeated denials also open the dialog. A denial tells the agent not to work around it. For most asks, the agent asks you with `ask_user_question` and retries once if you approve. A subagent stops instead and says so in its answer. After a denied `path` or `external_directory` ask, the agent retries once and the dialog opens.

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

Writes compaction summaries and the branch summaries for `/tree` and `/end-review` by forking the session, as Claude Code and Codex do. The fork lets the summary see full tool results. On Anthropic models the fork reads the conversation from the prompt cache. It compacts at the end of a turn once context reaches `compactAt` of the model's window. It falls back to pi's summarizer when a fork fails. Pi uses the `compaction` key, so this one reads `summaryFork`.

| Key                     | Default | Meaning                                                      |
| ----------------------- | ------- | ------------------------------------------------------------ |
| `summaryFork.compactAt` | `0.9`   | Share of the model's context window that triggers compaction |

### `fast.ts`

`/fast` requests fast mode from supported Anthropic models and the priority service tier from OpenAI. `--fast` starts with it on.

| Key                   | Default                                                   | Meaning                                         |
| --------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| `fast.models`         | `["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]` | Anthropic models that support fast mode         |
| `fast.beta`           | `"fast-mode-2026-02-01"`                                  | `anthropic-beta` header that enables it         |
| `fast.costMultiplier` | `2`                                                       | Price multiple for fast replies                 |
| `fastMode`            | `false`                                                   | Default on or off. `/fast` saves it with ctrl+s |

### `mcp-ancestors.ts`

Registers MCP servers from `.mcp.json` files in each folder from a root down to the session's folder, as Claude Code does. Nearer files win, and `~/.pi/agent/mcp.json` wins over all of them. In a trusted project, every file from the root down loads. In an untrusted project, none do, not even the root's.

| Key                  | Default | Meaning                                                       |
| -------------------- | ------- | ------------------------------------------------------------- |
| `mcpAncestors.roots` | `[]`    | Root folders. The deepest one that contains the session wins. |

### `mermaid.ts`

Draws mermaid blocks in the TUI with [lovely-mermaid](https://github.com/xl0/lovely-mermaid). It supports more mermaid syntax than pi's built-in renderer, so `home/agents/default.nix` turns pi's renderer off. It quotes labels that break a flowchart and redraws flowcharts top to bottom when they're too wide. A diagram that still doesn't draw shows its source and the reason. Its prompt rule tells the model which diagrams it can draw and how long labels can be. Nix installs lovely-mermaid at the version in `bun.lock`. No settings.

### `prompt-sections.ts`

Keeps extensions that append to the system prompt from breaking the prompt cache. It moves their text into an `appended` prompt section, so pi sends only the change instead of the whole prompt. `home/agents/default.nix` lists it last in `packages`, so it runs after the extensions it fixes. No settings.

### `skill-mention.ts`

`$name` anywhere in a prompt loads that skill. No settings.

### `stream-watchdog.ts`

Fails an Anthropic request whose stream stalls, so pi retries it. Anthropic keeps stalled streams open with pings, so pi would otherwise wait forever. The statusline's `stall` segment shows a countdown. The extension logs failed requests with their `request-id` to `~/.pi/agent/stream-watchdog.jsonl`.

| Key                              | Default    | Meaning                                                      |
| -------------------------------- | ---------- | ------------------------------------------------------------ |
| `streamWatchdog.headersMs`       | `60000`    | Wait for response headers                                    |
| `streamWatchdog.uploadMsPer32KB` | `1000`     | Extra header wait per 32 KB of request body                  |
| `streamWatchdog.firstEventMs`    | `60000`    | Wait from the headers to the first event                     |
| `streamWatchdog.eventIdleMs`     | `90000`    | Longest gap between events, not counting pings               |
| `streamWatchdog.byteIdleMs`      | `60000`    | Longest gap between bytes, counting pings                    |
| `streamWatchdog.warnMs`          | `30000`    | Silence before the statusline shows the countdown            |
| `streamWatchdog.log`             | `"stalls"` | `off`, `stalls`, or `all`, which also logs finished requests |

### `statusline.ts`

Replaces pi's footer with one line. If the settings are invalid, pi keeps its footer. `tokens` shows input (`↑`) and output (`↓`) tokens across all requests since your last message, including cached input. Output shows `~` while it's an estimate.

| Key                   | Default                  | Meaning                                                                                                                                  |
| --------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `statusline.segments` | all, in the order listed | Segments to show, in order. Any of `talk`, `autoMode`, `stall`, `model`, `thinking`, `fast`, `cwd`, `context`, `cost`, `tokens`, `speed` |

### `super-review.ts`

Adds optional extra reviewers to pi-review's `/review`. After pi-review's dialogs, you pick one or more models, by default `openai-codex/gpt-6.1-sol` for an Anthropic session and `anthropic/claude-opus-5-5` for an OpenAI one. Each reviews the same change as a pi-subagents subagent. Then all the models discuss the findings until they agree, and the session's model prints the agreed review.

| Key                                  | Default | Meaning                                                                                                   |
| ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| `superReview.adversaries.<provider>` | none    | Models for the "Adversaries" option, as `{ "model", "thinking" }`. ctrl+s in the custom picker saves them |
| `superReview.rounds`                 | `3`     | Rounds before the deadlock rule, multiplied by the number of adversaries                                  |

### `talk.ts`

`/talk` or shift+tab turns on read-only talk mode. It blocks `talk.blockedTools` and adds the prompt to each turn. It keeps the tool list and earlier messages unchanged, so toggling doesn't cost a prompt cache miss. `--talk` starts with it on.

| Key                 | Default             | Meaning                                                  |
| ------------------- | ------------------- | -------------------------------------------------------- |
| `talk.prompt`       | none, required      | Prompt added to each turn. nix sets it from `talkPrompt` |
| `talk.blockedTools` | `["edit", "write"]` | Tools blocked in talk mode                               |
