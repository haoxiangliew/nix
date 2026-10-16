# pi extensions

`home/agents/default.nix` links these [pi](https://pi.dev) extensions and the theme into `~/.pi/agent`. `src/lib/` contains shared code.

## Patches

`patches/pi-review.patch` changes [pi-review](https://github.com/earendil-works/pi-review):

- `/end-review` keeps the editor open so other extensions' dialogs remain visible. A widget shows progress. Esc cancels.
- "Review with a custom prompt" and `/review custom <prompt>` let you describe what to review.
- Each `/review` prompt emits `review:prompt` on `pi.events` for `super-review.ts`.
- The custom prompt and custom instructions dialogs autocomplete `$name` through `skill-mention.ts`. `$name` in the custom prompt, custom instructions, or `--extra` loads that skill into the review prompt.

The build fails if the patch stops applying after `nix flake update pi-review`.

## Configure

Extensions read the settings below from `~/.pi/agent/settings.json`. Set them through `programs.pi-coding-agent.settings` in `home/agents/default.nix`. Missing fields use the listed defaults. Run `/reload` after changes. Unknown keys or invalid values disable the extension and show an error. Activation does not delete old keys. Remove renamed keys by hand.

### `anthropic-billing.ts`

Sends pi's Anthropic OAuth requests with the headers, system prompt, and body signature of the installed `claude --print`. This covers agent turns, compaction, cache warming, and extension calls such as `/btw`. It captures the headers and system prompt by running `claude` against a local mock API, and reads the body signer from its binary. It reads the fingerprint, attribution fields, and request identity by parsing the JavaScript bundled in the `claude` binary. It re-scans when `claude`, the runtime, the scanner, or Acorn changes. It works only on macOS ARM64 and Linux x86-64.

Extension calls through `ctx.modelRegistry` use the session's billing identity. It blocks requests it cannot match. On non-Enterprise plans, it blocks further requests after a response uses usage credits. Run `/reload` after updating `claude` or pi, or switching accounts. No settings.

### `attention.ts`

Notifies when pi waits on a prompt or finishes, but not when you cancel with Esc. In herdr it marks prompts as blocked and only notifies for the active tab. It also tells the agent to ask for decisions with `ask_user_question`, since herdr shows a turn that ends on a question as done.

| Key                 | Default | Meaning                            |
| ------------------- | ------- | ---------------------------------- |
| `attention.title`   | `"pi"`  | Notification title                 |
| `attention.delayMs` | `1000`  | How long pi waits before notifying |

### `auto-mode.ts`

Reviews pi-permission-system requests with a model instead of asking you. Static rules in `home/agents/default.nix` allow read-only tools, read-only commands, and writes inside the project. Every other request goes to the reviewer. The reviewer trusts your messages and your answers to `ask_user_question`, not the agent's calls or output. Its checks run only programs and paths the agent may use without asking.

The reviewer can deny `path` and `external_directory` requests, but allowing one opens the dialog. Errors and repeated denials also open the dialog.

After a denial, the agent must not work around it. For most requests, it asks you with `ask_user_question` and retries once if you approve. A subagent stops and reports the denial instead. A denied `path` or `external_directory` request gets one unchanged retry, which opens the dialog.

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

Writes the summaries for compaction, `/tree`, and `/end-review` by forking the session, so the summary sees full tool results. Anthropic forks reuse the conversation's prompt cache when the request prefix matches. End-of-turn compaction starts when context reaches `compactAt` of the model's window.

If a fork for pi's own compaction or a branch summary fails, pi's summarizer runs instead. If an end-of-turn fork fails, compaction waits for pi's threshold. These settings use `summaryFork` because pi owns the `compaction` key.

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

Registers MCP servers from the `.mcp.json` in each folder from a configured root down to the session's folder, as Claude Code does. Nearer files win, and `~/.pi/agent/mcp.json` wins over all of them. Untrusted projects load none.

| Key                  | Default | Meaning                                                       |
| -------------------- | ------- | ------------------------------------------------------------- |
| `mcpAncestors.roots` | `[]`    | Root folders. The deepest one that contains the session wins. |

### `mermaid.ts`

Draws mermaid blocks with [lovely-mermaid](https://github.com/xl0/lovely-mermaid). It supports more mermaid syntax than pi's built-in renderer, so `home/agents/default.nix` turns pi's renderer off. It quotes labels containing semicolons and redraws wide flowcharts top to bottom. Failed diagrams show their source and an error. A prompt rule lists supported diagrams and label limits. Nix installs the version in `bun.lock`. No settings.

### `prompt-sections.ts`

Keeps extensions that append to the system prompt from breaking the prompt cache. It moves their text into an `appended` prompt section, so pi sends only the change instead of the whole prompt. `home/agents/default.nix` lists it last in `packages`, so it runs after the extensions it fixes. No settings.

### `skill-mention.ts`

`$name` anywhere in a prompt loads that skill. No settings.

Pi's autocomplete only reaches its main editor, and this extension's input handler skips prompts that extensions send. Other extensions get both through `pi.events`. `skill-mention:autocomplete` hands them a `$name` provider for their own editors, and `skill-mention:expand` loads skills for text the user typed.

### `statusline.ts`

Replaces pi's footer with a line of segments. If the settings are invalid, pi keeps its footer. Statuses that other extensions set with `setStatus` go on a second line, sorted by key. That line only appears when there are any. The `talk`, `autoMode`, and `fast` segments show their own statuses, so leaving one out hides that status. `tokens` shows input (`↑`) and output (`↓`) tokens across all requests since your last message, including cached input. Output shows `~` while it's an estimate.

| Key                   | Default                  | Meaning                                                                                                                         |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `statusline.segments` | all, in the order listed | Segments to show, in order. Any of `talk`, `autoMode`, `model`, `thinking`, `fast`, `cwd`, `context`, `cost`, `tokens`, `speed` |

### `super-review.ts`

Adds reviewers to pi-review's `/review`. Pick models after pi-review's dialogs. For an Anthropic session it suggests `openai/gpt-6.1-sol`, or `openai-codex/gpt-6.1-sol` if only Codex is logged in. For an OpenAI session it suggests `anthropic/claude-opus-5-5`.

Each model reviews the same change as a subagent. The parent model collects their reviews, compares findings, and runs discussion rounds. After the round limit, it drops findings that remain disputed and uses the lowest disputed priority. It prints the final review after the reviewers confirm the result.

| Key                                  | Default | Meaning                                                                                                   |
| ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| `superReview.adversaries.<provider>` | none    | Models for the "Adversaries" option, as `{ "model", "thinking" }`. ctrl+s in the custom picker saves them |
| `superReview.rounds`                 | `3`     | Rounds before the deadlock rule, multiplied by the number of adversaries                                  |

### `talk.ts`

`/talk` or shift+tab toggles read-only talk mode. It blocks `talk.blockedTools` and adds the prompt to each user-started run. The tool list and history stay unchanged to preserve the prompt cache. `--talk` starts with it on.

| Key                 | Default             | Meaning                                                  |
| ------------------- | ------------------- | -------------------------------------------------------- |
| `talk.prompt`       | none, required      | Prompt added to each turn. nix sets it from `talkPrompt` |
| `talk.blockedTools` | `["edit", "write"]` | Tools blocked in talk mode                               |
