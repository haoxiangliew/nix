# pi extensions

Extensions and a theme for [pi](https://pi.dev), linked into `~/.pi/agent` by `home/agents/default.nix`. `src/lib/` has code the extensions share.

## Patches

`patches/pi-review.patch` makes [pi-review](https://github.com/earendil-works/pi-review)'s `/end-review` keep the editor open while it summarizes, so dialogs from other extensions stay visible. It also shows progress in a widget and lets Esc cancel. The build fails if the patch stops applying after `nix flake update pi-review`.

## Configure

Each extension reads a top-level key in `~/.pi/agent/settings.json`, set from `programs.pi-coding-agent.settings` in `home/agents/default.nix`. Missing fields use the defaults below, and `/reload` picks up changes. An unknown key or invalid value turns the extension off with an error. Activation never deletes keys, so remove renamed ones by hand.

### `anthropic-billing.ts`

Sends pi's Anthropic OAuth requests with the headers, system prompt, and body signature of the installed `claude --print`. Compaction forks and cache warming use it too. No settings.

To learn these values, it runs `claude --print` through its launcher script against a local mock API, so no model call is made. It reads the signing code from the `claude` binary, which it can only do on macOS ARM64 and Linux x86-64. Each request gets the CLI's device and account IDs, pi's session ID, and new prompt and request IDs. It keeps pi's beta flags and adds the CLI's. Pi still handles login, token refresh, instructions, history, tools, and caching, so the body doesn't match the CLI's byte for byte.

It blocks a request when:

- the `claude` binary is a build it can't read
- `claude` or pi changed on disk since pi loaded it
- pi's headers or system prompt differ from what pi's built-in Anthropic provider sends
- pi and the CLI are logged in to different accounts
- the fingerprint or checksum check fails

After updating `claude` or pi, run `/reload`. Restart pi after adding or removing the extension.

It reads your plan from `claude auth status` once per `/reload`, so run `/reload` after you switch accounts or plans. Enterprise may use usage credits. On other plans, each successful response must have an `anthropic-ratelimit-unified-representative-claim` header that isn't `overage`. Otherwise it cancels the stream and blocks the rest of the session. Anthropic may still charge that one request, so turn off usage credits on Max if you never want to spend them.

Captured headers and bodies stay in memory. Requests with an API key, and requests to other endpoints, pass through unchanged. This extension and `stream-watchdog.ts` both wrap the global `fetch`, so code that brings its own `fetch` skips these checks.

### `attention.ts`

Notifies when pi waits on a prompt or finishes. In herdr it marks prompts as blocked and only notifies for the active tab.

| Key                 | Default | Meaning                            |
| ------------------- | ------- | ---------------------------------- |
| `attention.title`   | `"pi"`  | Notification title                 |
| `attention.delayMs` | `1000`  | How long pi waits before notifying |

### `auto-mode.ts`

Reviews pi-permission-system asks with a model. The static rules in `home/agents/default.nix` allow only what is safe without review, and every other ask comes here.

The reviewer trusts your messages and your answers to `ask_user_question`. It treats the agent's tool calls, and the output of its own checks, as untrusted. It never sees the agent's tool output or the agent's own text. A one-word classifier allows most asks. The rest get an assessment of their risk and of how far you authorized them, which decides allow or deny. Before deciding, the assessment can run programs without a shell, limited to the programs and paths the agent may use without asking. The review log records each one as `auto_mode_run`. When auto mode denies an ask, or allows one that pi-permission-system still sends to you, a notification says why.

pi-permission-system won't let a reviewer allow `path` or `external_directory` asks, such as writes outside the project. Auto mode can deny them. Otherwise they open the dialog. Dropped connections and 5xx errors retry with backoff within the timeout. Other errors and repeated denials open the dialog.

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
| `autoMode.environment`                  | `[]`                                                             | Orgs, domains, and services the reviewer trusts                          |
| `autoMode.context.messageTokens`        | `5000`                                                           | Limit per user message                                                   |
| `autoMode.context.toolCallTokens`       | `1000`                                                           | Limit per tool call                                                      |
| `autoMode.context.threadTokens`         | `30000`                                                          | Review thread size before it starts over                                 |
| `autoMode.investigation.maxCommands`    | `5`                                                              | Programs the assessment may run per review. `0` turns this off           |
| `autoMode.investigation.timeoutMs`      | `10000`                                                          | Timeout per program                                                      |
| `autoMode.investigation.totalTimeoutMs` | `60000`                                                          | Time for the whole second stage, checked before each model call          |
| `autoMode.investigation.outputTokens`   | `2000`                                                           | Output kept per program                                                  |

### `compaction.ts`

Writes every compaction and branch summary (`/tree`, `/end-review`) by forking the session, as Claude Code and Codex do. The fork resends the session's conversation with pi's summary prompt after it, so it sees full tool results and can write up to the model's output limit. On Anthropic models it reuses the session's last request (system prompt, tools, thinking, fast mode, and message prefix), so it reads the conversation from the prompt cache. Otherwise it skips the conversation cache write, since nothing would read it. A notification shows how much of each fork's input came from the cache.

Pi's trigger is a fixed reserve per model, so this compacts at the end of a turn once context reaches `compactAt` of the model's window. It keeps recent messages per pi's `compaction.keepRecentTokens`. Pi's own compaction (overflow, `/compact`) forks too. A fork over `compactAt` drops its oldest turns. Pi's summarizer runs when a fork fails. Esc cancels. Pi uses the `compaction` key, so this one reads `summaryFork`.

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

Registers MCP servers from `.mcp.json` files in each folder from a root down to the session's folder. Nearer files override farther ones, and a server of the same name in `~/.pi/agent/mcp.json` wins. The root's own file always loads, and files below it load only in a trusted project. It expands `${VAR}` and `${VAR:-default}` as Claude Code does. A bad file or entry shows an error and is skipped.

| Key                  | Default | Meaning                                                       |
| -------------------- | ------- | ------------------------------------------------------------- |
| `mcpAncestors.roots` | `[]`    | Root folders. The deepest one that contains the session wins. |

### `skill-mention.ts`

`$name` anywhere in a prompt loads that skill. No settings.

### `stream-watchdog.ts`

Fails an Anthropic request whose stream stalls, so pi retries it. Anthropic keeps stalled streams open with pings, so pi would otherwise wait forever.

It fails a request that gets:

- no response headers within `headersMs`
- no first event within `firstEventMs`
- no event for `eventIdleMs`, not counting pings
- once events arrive, no bytes for `byteIdleMs`, counting pings

Pi's `retry` settings control the retry, and Esc cancels it. The statusline's `stall` segment shows a countdown for the session's own replies. It logs failed requests with their `request-id` to `~/.pi/agent/stream-watchdog.jsonl`.

| Key                              | Default    | Meaning                                                      |
| -------------------------------- | ---------- | ------------------------------------------------------------ |
| `streamWatchdog.headersMs`       | `60000`    | Wait for response headers                                    |
| `streamWatchdog.uploadMsPer32KB` | `1000`     | Extra header wait per 32 KB of request body                  |
| `streamWatchdog.firstEventMs`    | `60000`    | Wait from the headers to the first event                     |
| `streamWatchdog.eventIdleMs`     | `90000`    | Longest gap between events, not counting pings               |
| `streamWatchdog.byteIdleMs`      | `60000`    | Longest gap between bytes, counting pings                    |
| `streamWatchdog.warnMs`          | `30000`    | Silence before the status line shows the countdown           |
| `streamWatchdog.log`             | `"stalls"` | `off`, `stalls`, or `all`, which also logs finished requests |

### `statusline.ts`

Replaces pi's footer with one line. Invalid settings keep pi's footer. `tokens` shows input (`↑`) and output (`↓`) tokens across all requests since your last message, including cached input. Output shows `~` while it's an estimate.

| Key                   | Default                  | Meaning                                                                                                                                  |
| --------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `statusline.segments` | all, in the order listed | Segments to show, in order. Any of `talk`, `autoMode`, `stall`, `model`, `thinking`, `fast`, `cwd`, `context`, `cost`, `tokens`, `speed` |

### `talk.ts`

`/talk` or shift+tab turns on read-only talk mode. It blocks `talk.blockedTools` and adds the prompt to each turn. It keeps the tool list and earlier messages unchanged, so toggling doesn't cost a prompt cache miss. `--talk` starts with it on.

| Key                 | Default             | Meaning                                                  |
| ------------------- | ------------------- | -------------------------------------------------------- |
| `talk.prompt`       | none, required      | Prompt added to each turn. nix sets it from `talkPrompt` |
| `talk.blockedTools` | `["edit", "write"]` | Tools blocked in talk mode                               |
