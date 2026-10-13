/**
 * Adds extra reviewers to pi-review's /review, configured by `superReview` in settings.json.
 *
 * The session's model runs the rounds with subagent resumes and collects each result with
 * get_subagent_result, so pi-subagents doesn't also post it. The service has no way to collect a
 * result, so if this extension ran the rounds, pi-subagents would post each one and start an extra
 * turn.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentsService } from "@gotgenes/pi-subagents";

import { DynamicBorder, getSelectListTheme, keyText } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { loadOrReport, saveSetting } from "./lib/settings.ts";

const Adversary = Type.Object(
  {
    model: Type.String({ pattern: "^[^/\\s]+/\\S+$" }),
    // Unset follows the session's thinking level.
    thinking: Type.Optional(Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
  },
  { additionalProperties: false },
);

type Adversary = Static<typeof Adversary>;

const Config = Type.Object(
  {
    // Keyed by the session model's provider. ctrl+s in the custom picker sets it.
    adversaries: Type.Record(Type.String(), Type.Array(Adversary, { minItems: 1 }), {
      default: {},
    }),
    // Round limit, multiplied by the number of adversaries. The sign-off isn't counted.
    rounds: Type.Integer({ minimum: 1, default: 3 }),
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

// Offered when no adversaries are saved.
const SUGGESTED_MODELS = new Map<string, Adversary[]>([
  ["anthropic", [{ model: "openai-codex/gpt-6.1-sol" }]],
  ["openai", [{ model: "anthropic/claude-opus-5-5" }]],
  ["openai-codex", [{ model: "anthropic/claude-opus-5-5" }]],
]);

// patches/pi-review.patch emits each review prompt on this channel before sending it.
const REVIEW_PROMPT_EVENT = "review:prompt";

// freshSession: the user picked "Empty branch" in pi-review's "Start review in:" dialog.
const ReviewPrompt = Type.Object({ prompt: Type.String(), freshSession: Type.Boolean() });

const SERVICE = Symbol.for("@gotgenes/pi-subagents:service");

const NO_ADVERSARY = "No adversary";

const CUSTOM_ADVERSARIES = "Custom adversaries";

const CONTEXT_TYPE = "super-review";

function rules(limit: number): string {
  return `- Judge each finding by what the review instructions say to flag.
- For each open finding, reply with exactly one of: accept, withdraw, or reject with a file:line and the concrete reason the instructions wouldn't flag it. Settle priorities the same way, using the instructions' priority levels.
- A rejection without a file:line and a concrete reason counts as accept.
- A finding is agreed once every reviewer accepts it.
- The deadlock rule ends what's left after ${limit} rounds. A finding any reviewer still rejects is dropped, and a priority still disputed becomes the least severe one any reviewer holds, because none was proven.`;
}

function adversaryBriefing(others: number, limit: number): string {
  return `${others === 1 ? "Another model" : `${others} other models`} ran the same review. The findings you didn't raise follow, with who raised each. Settle every finding with them by these rules:

${rules(limit)}

Each round, reply by the rules to each open finding and priority you're sent. The others check your findings at the same time, and you get their replies in the next round. At the end you get the final list and verdict. Confirm them, or name each place they misstate what you agreed to.`;
}

const ResumeCall = Type.Object({ resume: Type.String(), prompt: Type.String() });

type Pending = {
  service: SubagentsService;
  prompt: string;
  inheritContext: boolean;
  adversaries: Adversary[];
  reviewer: string;
  limit: number;
};

type Spawned = { id: string; model: string; rulesSent: boolean };

type Review = {
  service: SubagentsService;
  adversaries: Spawned[];
  reviewer: string;
  limit: number;
  consensusStarted: boolean;
};

function presetLabel(preset: Adversary[]): string {
  const names = preset.map(({ model }) => model).join(", ");

  return `${preset.length === 1 ? "Adversary" : "Adversaries"} (${names})`;
}

// Keeps the thinking level of each model that already has one.
function withThinking(models: string[], known: Adversary[]): Adversary[] {
  return models.map((model) => known.find((adversary) => adversary.model === model) ?? { model });
}

function pickModels(
  ctx: ExtensionContext,
  initial: string[],
  onSave: (models: string[]) => void,
): Promise<string[]> {
  const available = ctx.modelRegistry
    .getAvailable()
    .map((model) => `${model.provider}/${model.id}`);

  // Saved models without credentials stay listed and checked, so only a toggle removes them.
  const models = [...new Set([...initial, ...available])].toSorted(
    (a, b) => Number(initial.includes(b)) - Number(initial.includes(a)) || a.localeCompare(b),
  );

  const checked = new Set(initial);
  const selection = () => models.filter((model) => checked.has(model));

  return ctx.ui.custom<string[]>((tui, theme, keybindings, done) => {
    const searchInput = new Input();
    const listContainer = new Container();
    const footer = new Text("");
    const container = new Container();
    const accent = (text: string) => theme.fg("accent", text);
    let unsaved = false;

    const listTheme = {
      ...getSelectListTheme(),
      scrollInfo: (text: string) => theme.fg("dim", text),
      // SelectList's own message says "commands".
      noMatch: () => theme.fg("warning", "  No matching models"),
    };

    function showList(current: string | undefined): SelectList {
      const query = searchInput.getValue();

      const rows = models.map((model) => ({
        value: model,
        label: `${checked.has(model) ? "[x]" : "[ ]"} ${model}${available.includes(model) ? "" : " (unavailable)"}`,
      }));

      const shown = query ? fuzzyFilter(rows, query, (row) => row.value) : rows;
      const list = new SelectList(shown, Math.min(shown.length, 10), listTheme);

      list.setSelectedIndex(shown.findIndex((row) => row.value === current));
      listContainer.clear();
      listContainer.addChild(list);

      const hints = `Type to filter • ${keyText("tui.select.confirm")} toggle • ${keyText("app.models.save")} save • ${keyText("tui.select.cancel")} done • ${checked.size} selected`;

      footer.setText(theme.fg("dim", hints) + (unsaved ? theme.fg("warning", " (unsaved)") : ""));

      return list;
    }

    let selectList = showList(undefined);

    for (const child of [
      new DynamicBorder(accent),
      new Text(accent(theme.bold(CUSTOM_ADVERSARIES))),
      searchInput,
      new Spacer(1),
      listContainer,
      footer,
      new DynamicBorder(accent),
    ]) {
      container.addChild(child);
    }

    function toggle(model: string): void {
      if (!checked.delete(model)) {
        checked.add(model);
      }

      unsaved = true;
    }

    // Keys that don't change the search text, like the arrows, go to the list.
    function handleInput(data: string): void {
      const current = selectList.getSelectedItem()?.value;
      const query = searchInput.getValue();

      if (keybindings.matches(data, "tui.select.cancel")) {
        done(selection());

        return;
      }

      if (keybindings.matches(data, "app.models.save")) {
        onSave(selection());
        unsaved = false;
      } else if (keybindings.matches(data, "tui.select.confirm") && current !== undefined) {
        toggle(current);
      } else {
        searchInput.handleInput(data);

        if (searchInput.getValue() === query) {
          selectList.handleInput(data);
        }
      }

      selectList = showList(selectList.getSelectedItem()?.value ?? current);
      tui.requestRender();
    }

    // The search box draws its cursor only while focused.
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput,
      get focused() {
        return searchInput.focused;
      },
      set focused(value: boolean) {
        searchInput.focused = value;
      },
    };
  });
}

function reviewerInstructions({ adversaries, reviewer, limit }: Review): string {
  const subagents = adversaries.map(({ id, model }) => `- ${model}, subagent "${id}"`).join("\n");

  return `These models ran the same review as subagents:

${subagents}

Settle every finding with all of them before you print the final review, by these rules. The rules are added to your first message to each one, so don't repeat them yourself. The user's messages reach a subagent only while it's working, so repeat any new ones in your next message to it.

${rules(limit)}

Each round, you and the subagents reply at the same time to what was sent in the last round.

1. Call get_subagent_result with wait: true for each subagent to collect its review. Leave out any that failed and say so. If all failed, stop, so your review stands.
2. Compare the reviews. Two findings match only if they name the same defect at overlapping lines. A finding every reviewer raised is agreed, and every other finding is open.
3. For each subagent, call subagent with its id as resume and run_in_background: true. In the first round, send it every open finding it didn't raise, with who raised it. After that, send it your replies and the other subagents' replies from the last round.
4. While they work, check the code and reply by the rules to every open finding you didn't raise.
5. Call get_subagent_result with wait: true for each subagent to collect its replies. A finding is dropped once its author withdraws it.
6. Repeat steps 3 to 5 with only what is still open. Stop after ${limit} rounds and apply the deadlock rule.
7. Send each subagent the final list and verdict with a resume and run_in_background: true, then collect each with get_subagent_result. Fix each place that any of them says misstates what it agreed to.
8. Print the final review in the format the review instructions ask for, with the human reviewer callouts from every review. Start it by saying it replaces your first review, and that findings missing from it were dropped. After each finding's title, say who raised it, naming ${reviewer} for yourself. For each finding or priority the deadlock rule settled, say so and give each side's position in one sentence.`;
}

// If a spawn throws, stops the adversaries already started, since no review will collect them.
function spawnAll(spawn: Pending, sessionThinking: string): Spawned[] {
  const spawned: Spawned[] = [];

  try {
    for (const { model, thinking } of spawn.adversaries) {
      // general-purpose with no prompt of its own copies the session's system prompt and tools.
      const id = spawn.service.spawn("general-purpose", spawn.prompt, {
        description: "Super review adversary",
        model,
        thinkingLevel: thinking ?? sessionThinking,
        foreground: false,
        bypassQueue: true,
        inheritContext: spawn.inheritContext,
      });

      spawned.push({ id, model, rulesSent: false });
    }
  } catch (error) {
    for (const { id } of spawned) {
      spawn.service.abort(id);
    }

    throw error;
  }

  return spawned;
}

export default function (pi: ExtensionAPI) {
  let config: Config | undefined;
  let service: SubagentsService | undefined;
  let reviewPrompt: Static<typeof ReviewPrompt> | undefined;
  // Set from the menu choice until the review prompt's run starts.
  let pending: Pending | undefined;
  // Set from the spawn until the run that reviews settles, which covers both stages.
  let review: Review | undefined;

  function loadConfig(ctx: ExtensionContext): void {
    config = loadOrReport(ctx, "Super review", "superReview", Config);
  }

  async function pickCustom(
    ctx: ExtensionContext,
    provider: string,
    preset: Adversary[],
  ): Promise<Adversary[]> {
    const models = await pickModels(
      ctx,
      preset.map(({ model }) => model),
      (selected) => {
        // An empty selection removes the saved list, so the suggested model comes back.
        saveSetting(
          `superReview/adversaries/${provider}`,
          selected.length > 0 ? withThinking(selected, preset) : undefined,
        );
        loadConfig(ctx);
        ctx.ui.notify(`Default adversaries for ${provider}: ${selected.join(", ") || "none"}`);
      },
    );

    return withThinking(models, preset);
  }

  async function ask(
    ctx: ExtensionContext,
    provider: string,
    saved: Adversary[] | undefined,
  ): Promise<Adversary[] | undefined> {
    const preset = saved ?? SUGGESTED_MODELS.get(provider);

    const option = await ctx.ui.select(
      "Adversaries:",
      preset === undefined
        ? [NO_ADVERSARY, CUSTOM_ADVERSARIES]
        : [NO_ADVERSARY, presetLabel(preset), CUSTOM_ADVERSARIES],
    );

    if (option === CUSTOM_ADVERSARIES) {
      const custom = await pickCustom(ctx, provider, preset ?? []);

      return custom.length > 0 ? custom : ask(ctx, provider, config?.adversaries[provider]);
    }

    return option === undefined || option === NO_ADVERSARY ? undefined : preset;
  }

  pi.on("session_start", async (_event, ctx) => {
    loadConfig(ctx);
    // Each subagent loads its own pi-subagents, which replaces the shared service with one that
    // doesn't know this session's subagents. Keep the session's own.
    // SAFETY: pi-subagents publishes its service under this Symbol.for() key.
    // pi installs the package outside this file's module path, so it can't be imported instead.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    service = Object.getOwnPropertyDescriptor(globalThis, SERVICE)?.value as
      | SubagentsService
      | undefined;
  });

  pi.events.on(REVIEW_PROMPT_EVENT, (data) => {
    Value.Assert(ReviewPrompt, data);
    reviewPrompt = data;
  });

  pi.on("input", async (event, ctx) => {
    const emitted = reviewPrompt;

    if (event.source !== "extension" || event.text !== emitted?.prompt) {
      return;
    }

    reviewPrompt = undefined;

    const session = ctx.model;
    const settings = config;

    if (settings === undefined || service === undefined || session === undefined) {
      return;
    }

    const adversaries =
      ctx.mode === "tui"
        ? await ask(ctx, session.provider, settings.adversaries[session.provider])
        : undefined;

    if (adversaries !== undefined) {
      pending = {
        service,
        prompt: event.text,
        inheritContext: !emitted.freshSession,
        adversaries,
        reviewer: `${session.provider}/${session.id}`,
        limit: settings.rounds * adversaries.length,
      };
    }
  });

  // Spawns after pi compacts before the prompt and right before agent_start, when pi-subagents
  // starts holding back results until the run settles. If a spawn throws, pi reports the error and
  // the review runs without adversaries.
  pi.on("before_agent_start", async (_event, ctx) => {
    const spawn = pending;

    pending = undefined;

    if (spawn === undefined) {
      return;
    }

    const adversaries = spawnAll(spawn, pi.getThinkingLevel());

    review = {
      service: spawn.service,
      adversaries,
      reviewer: spawn.reviewer,
      limit: spawn.limit,
      consensusStarted: false,
    };

    const names = adversaries.map(({ id, model }) => `${model} (${id})`).join(", ");

    ctx.ui.notify(`Adversary review started: ${names}.`, "info");
  });

  pi.on("input", async (event) => {
    const current = review;

    if (current !== undefined && event.source !== "extension") {
      await Promise.all(current.adversaries.map(({ id }) => current.service.steer(id, event.text)));
    }
  });

  // pi-subagents posts results after the run settles, so continuing this run lets the session's
  // model collect the results first.
  pi.on("agent_before_settle", async (event) => {
    if (review === undefined || review.consensusStarted || event.outcome !== "completed") {
      return;
    }

    review.consensusStarted = true;

    const content = reviewerInstructions(review);

    return {
      entries: [{ type: "custom_message", customType: CONTEXT_TYPE, content, display: false }],
      continue: true,
    };
  });

  // Stops adversaries that are still working when the run ends early. After a finished consensus
  // they're idle, and abort does nothing.
  pi.on("agent_settled", async () => {
    const current = review;

    review = undefined;

    if (current === undefined) {
      return;
    }

    for (const { id } of current.adversaries) {
      current.service.abort(id);
    }
  });

  pi.on("tool_call", async (event) => {
    if (
      review === undefined ||
      event.toolName !== "subagent" ||
      !Value.Check(ResumeCall, event.input)
    ) {
      return;
    }

    const { resume, prompt } = event.input;
    const target = review.adversaries.find(({ id, rulesSent }) => id === resume && !rulesSent);

    if (target !== undefined) {
      target.rulesSent = true;
      event.input.prompt = `${adversaryBriefing(review.adversaries.length, review.limit)}\n\n---\n\n${prompt}`;
    }
  });
}
