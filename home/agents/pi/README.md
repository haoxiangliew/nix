# pi extensions

Extensions and a theme for [pi](https://pi.dev), linked into `~/.pi/agent` by `home/agents/default.nix`. `src/lib/` has code the extensions share.

## Patches

`patches/pi-review.patch` makes [pi-review](https://github.com/earendil-works/pi-review)'s `/end-review` keep the editor open while it summarizes, so dialogs from other extensions stay visible. It also shows progress in a widget and lets Esc cancel. The build fails if the patch stops applying after `nix flake update pi-review`.

## Configure

Each extension reads a top-level key in `~/.pi/agent/settings.json`, set from `programs.pi-coding-agent.settings` in `home/agents/default.nix`. Missing fields use the defaults below, and `/reload` picks up changes. An unknown key or invalid value turns the extension off with an error. Activation never deletes keys, so remove renamed ones by hand.

### `attention.ts`

Notifies when pi waits on a prompt or finishes. In herdr it marks prompts as blocked and only notifies for the active tab.

| Key                 | Default | Meaning                            |
| ------------------- | ------- | ---------------------------------- |
| `attention.title`   | `"pi"`  | Notification title                 |
| `attention.delayMs` | `1000`  | How long pi waits before notifying |

### `auto-mode.ts`

Reviews pi-permission-system asks with a model. A one-token first stage allows most asks, and a flagged ask gets a reasoned verdict. When auto mode denies an ask or leaves it to you, a notification says why. Dropped connections and 5xx errors retry with backoff within the timeout. Other errors and repeated denials open the dialog.

| Key                               | Default                            | Meaning                                                               |
| --------------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `autoMode.model`                  | `"openai-codex/codex-auto-review"` | Reviewer model as `provider/id`                                       |
| `autoMode.reasoning`              | `"low"`                            | Reasoning for the second stage                                        |
| `autoMode.firstStage`             | `true`                             | Run the one-token first stage                                         |
| `autoMode.timeoutMs`              | `30000`                            | Timeout for each model call, including its retries                    |
| `autoMode.maxRetries`             | `3`                                | Retries per model call after a transient error                        |
| `autoMode.retryDelayMs`           | `250`                              | Wait before the first retry                                           |
| `autoMode.maxRetryDelayMs`        | `2000`                             | Longest wait between retries                                          |
| `autoMode.maxDenials`             | `3`                                | Denials in a row before asks go to the dialog until your next message |
| `autoMode.environment`            | `[]`                               | Orgs, domains, and services the reviewer treats as yours              |
| `autoMode.context.messageTokens`  | `5000`                             | Limit per user message                                                |
| `autoMode.context.toolCallTokens` | `1000`                             | Limit per tool call                                                   |
| `autoMode.context.threadTokens`   | `30000`                            | Review thread size before it starts over                              |

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
| `streamWatchdog.firstEventMs`    | `180000`   | Wait from the headers to the first event                     |
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

`/talk` or shift+tab turns on read-only talk mode. It removes the blocked tools and adds the prompt to each turn. `--talk` starts with it on.

| Key                 | Default             | Meaning                                                  |
| ------------------- | ------------------- | -------------------------------------------------------- |
| `talk.prompt`       | none, required      | Prompt added to each turn. nix sets it from `talkPrompt` |
| `talk.blockedTools` | `["edit", "write"]` | Tools removed and blocked in talk mode                   |
