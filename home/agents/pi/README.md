# pi extensions

Extensions and a theme for [pi](https://pi.dev). `home/agents/default.nix` links each file in `src/` into `~/.pi/agent/extensions`, and `src/themes/dracula-pro.json` into `~/.pi/agent/themes`. `src/lib/` holds code the extensions share. pi doesn't load it as an extension because it has no `index.ts`.

## Develop

```sh
bun install
bun run lint     # oxlint with type checking
bun run format   # oxfmt
bun run taze     # dependency updates
```

`nix fmt` at the repo root runs `lint:fix` and `format` on this directory. It runs `bun install` first.

`@earendil-works/*`, `@types/bun`, and `typebox` in `package.json` are for type checking. pi supplies them at runtime, so code that uses an API newer than the pi nix installs type-checks but fails to load. `@gotgenes/pi-permission-system` matches the version pi installs from npm, so check it after `pi update`.

## Configure

Each extension reads a top-level key in `~/.pi/agent/settings.json`. Set it in `programs.pi-coding-agent.settings` in `home/agents/default.nix`, or edit the file directly. Fields you leave out use the defaults below, and `/reload` picks up changes.

An unknown key or invalid value turns that extension off and shows an error that names the field. Activation merges nix's settings into the file without deleting anything, so remove old keys by hand after renaming a field in nix.

### `attention.ts`

Notifies when pi waits on a prompt or finishes. Inside herdr it reports prompts as blocked and notifies only for the active tab. It skips "Ready for input" while the stall watchdog counts down to a retry.

| Key                 | Default | Meaning                            |
| ------------------- | ------- | ---------------------------------- |
| `attention.title`   | `"pi"`  | Notification title                 |
| `attention.delayMs` | `1000`  | How long pi waits before notifying |

### `auto-mode.ts`

Reviews pi-permission-system asks with a model, like Claude Code's auto mode. A one-token first stage allows most asks. A flagged ask gets a reasoned verdict. A notification gives the reason whenever auto mode denies an ask or leaves it to you, since the permission dialog can't show one. Errors and repeated denials also open the dialog.

| Key                               | Default                            | Meaning                                                               |
| --------------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `autoMode.model`                  | `"openai-codex/codex-auto-review"` | Reviewer model as `provider/id`                                       |
| `autoMode.reasoning`              | `"low"`                            | Reasoning for the second stage                                        |
| `autoMode.firstStage`             | `true`                             | Run the one-token first stage                                         |
| `autoMode.timeoutMs`              | `30000`                            | Timeout for each model call                                           |
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

### `skill-mention.ts`

`$name` anywhere in a prompt loads that skill. No settings.

### `stall-watchdog.ts`

Aborts a model request that stops streaming output, then retries it. Anthropic keeps stalled streams open with pings, so pi would otherwise wait forever. Streamed thinking counts as output. While a request is silent, the status line counts down to the abort. After it, the status line counts down to the retry. Your interrupt key (`app.interrupt`, Esc by default) or a new message cancels it. Retries wait `retryDelayMs`, doubling each time up to `maxRetryDelayMs`, like OpenCode.

| Key                             | Default  | Meaning                                            |
| ------------------------------- | -------- | -------------------------------------------------- |
| `stallWatchdog.firstTokenMs`    | `180000` | Wait for the first output before aborting          |
| `stallWatchdog.idleMs`          | `90000`  | Silence after output started before aborting       |
| `stallWatchdog.warnMs`          | `30000`  | Silence before the status line shows the countdown |
| `stallWatchdog.maxRetries`      | `5`      | Retries per user message                           |
| `stallWatchdog.retryDelayMs`    | `2000`   | Wait before the first retry                        |
| `stallWatchdog.maxRetryDelayMs` | `30000`  | Longest wait between retries                       |

### `statusline.ts`

Replaces pi's footer with one line. Invalid settings keep pi's built-in footer. `tokens` shows input (`↑`) and output (`↓`) tokens since your last message, summed over every model request it caused. Input includes cached tokens. Output is estimated, with a `~`, while a reply streams.

| Key                   | Default                  | Meaning                                                                                                                                  |
| --------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `statusline.segments` | all, in the order listed | Segments to show, in order. Any of `talk`, `autoMode`, `stall`, `model`, `thinking`, `fast`, `cwd`, `context`, `cost`, `tokens`, `speed` |

### `talk.ts`

`/talk` or shift+tab turns on read-only talk mode. It removes the blocked tools and adds the prompt to each turn. `--talk` starts with it on.

| Key                 | Default             | Meaning                                                  |
| ------------------- | ------------------- | -------------------------------------------------------- |
| `talk.prompt`       | none, required      | Prompt added to each turn. nix sets it from `talkPrompt` |
| `talk.blockedTools` | `["edit", "write"]` | Tools removed and blocked in talk mode                   |
