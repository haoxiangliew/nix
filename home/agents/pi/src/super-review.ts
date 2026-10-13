/**
 * Adds an opt-in adversarial pass to pi-review's /review. After pi-review's dialogs, a menu offers an
 * adversary model, which runs the same review prompt as a pi-subagents subagent. When the session's
 * model finishes its review, it settles every finding with the subagent and prints the final
 * review. Configured by `superReview` in settings.json.
 *
 * The session's model runs the rounds with subagent resumes and collects each result with
 * get_subagent_result, so pi-subagents doesn't also post it. The service has no way to collect a
 * result, so if this extension ran the rounds, pi-subagents would post each one and start an extra
 * turn.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentsService } from "@gotgenes/pi-subagents";

import { DynamicBorder, getSelectListTheme, keyText } from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { loadOrReport, saveSetting } from "./lib/settings.ts";

const Adversary = Type.Object(
  {
    // The model "Adversary (...)" offers. ctrl+s in the custom picker sets it.
    model: Type.Optional(Type.String({ pattern: "^[^/\\s]+/\\S+$" })),
    // Unset follows the session's thinking level.
    thinking: Type.Optional(Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
  },
  { additionalProperties: false },
);

const Config = Type.Object(
  {
    // Keyed by the session model's provider.
    adversaries: Type.Record(Type.String(), Adversary, { default: {} }),
    // Rounds before the deadlock rule settles what's left. The sign-off resume isn't counted.
    rounds: Type.Integer({ minimum: 1, default: 3 }),
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

// Offered when no model is saved.
const SUGGESTED_MODELS = new Map([
  ["anthropic", "openai-codex/gpt-6.1-sol"],
  ["openai", "anthropic/claude-opus-5-5"],
  ["openai-codex", "anthropic/claude-opus-5-5"],
]);

// patches/pi-review.patch emits each review prompt on this channel before sending it.
const REVIEW_PROMPT_EVENT = "review:prompt";

// freshSession: the user picked "Empty branch" in pi-review's "Start review in:" dialog.
const ReviewPrompt = Type.Object({ prompt: Type.String(), freshSession: Type.Boolean() });

const SERVICE = Symbol.for("@gotgenes/pi-subagents:service");

const NO_ADVERSARY = "No adversary";

const CUSTOM_ADVERSARY = "Custom adversary";

const CONTEXT_TYPE = "super-review";

function rules(rounds: number): string {
  return `- Judge each finding by what the review instructions say to flag.
- For each open finding, reply with exactly one of: accept, withdraw, or reject with a file:line and the concrete reason the instructions wouldn't flag it. Settle priorities the same way, using the instructions' priority levels.
- A rejection without a file:line and a concrete reason counts as accept.
- The deadlock rule ends what's left after ${rounds} rounds. A finding still rejected is dropped, and a priority still disputed becomes the less severe one, because neither was proven.`;
}

function adversaryBriefing(rounds: number): string {
  return `Another model ran the same review. Its findings follow. Settle every finding with it by these rules:

${rules(rounds)}

Each round, reply by the rules to each open finding and priority it sends. It checks your findings at the same time and sends its replies in the next round. At the end it sends you the final list and verdict. Confirm them, or name each place they misstate what you agreed to.`;
}

const ResumeCall = Type.Object({ resume: Type.String(), prompt: Type.String() });

type Choice = { model: string; save: boolean };

type Pending = {
  service: SubagentsService;
  prompt: string;
  inheritContext: boolean;
  adversary: string;
  reviewer: string;
  thinking: string | undefined;
  rounds: number;
};

type Review = {
  service: SubagentsService;
  id: string;
  adversary: string;
  reviewer: string;
  rounds: number;
  consensusStarted: boolean;
  rulesSent: boolean;
};

// Lists first at the top, then the other models by name.
function adversaryItems(
  ctx: ExtensionContext,
  first: string | undefined,
  saved: string | undefined,
): SelectItem[] {
  return ctx.modelRegistry
    .getAvailable()
    .map((model) => `${model.provider}/${model.id}`)
    .toSorted((a, b) => Number(b === first) - Number(a === first) || a.localeCompare(b))
    .map((model) => ({
      value: model,
      label: model,
      description: model === saved ? "(default)" : "",
    }));
}

function pickModel(
  ctx: ExtensionContext,
  first: string | undefined,
  saved: string | undefined,
): Promise<Choice | undefined> {
  const items = adversaryItems(ctx, first, saved);

  return ctx.ui.custom<Choice | undefined>((tui, theme, keybindings, done) => {
    const searchInput = new Input();
    const listContainer = new Container();
    const container = new Container();
    const hints = `Type to filter • enter to select • ${keyText("app.models.save")} to set as default • esc to go back`;
    const accent = (text: string) => theme.fg("accent", text);

    const listTheme = {
      ...getSelectListTheme(),
      scrollInfo: (text: string) => theme.fg("dim", text),
      // SelectList's own message says "commands".
      noMatch: () => theme.fg("warning", "  No matching models"),
    };

    function showList(shown: SelectItem[]): SelectList {
      const list = new SelectList(shown, Math.min(shown.length, 10), listTheme);

      list.onSelect = (item) => done({ model: item.value, save: false });
      list.onCancel = () => done(undefined);
      listContainer.clear();
      listContainer.addChild(list);

      return list;
    }

    let selectList = showList(items);

    for (const child of [
      new DynamicBorder(accent),
      new Text(accent(theme.bold(CUSTOM_ADVERSARY))),
      searchInput,
      new Spacer(1),
      listContainer,
      new Text(theme.fg("dim", hints)),
      new DynamicBorder(accent),
    ]) {
      container.addChild(child);
    }

    // Keys that don't change the search text, like arrows, enter, and esc, go to the list.
    function handleInput(data: string): void {
      const query = searchInput.getValue();

      if (keybindings.matches(data, "app.models.save")) {
        const item = selectList.getSelectedItem();

        if (item) {
          done({ model: item.value, save: true });
        }
      } else {
        searchInput.handleInput(data);

        if (searchInput.getValue() === query) {
          selectList.handleInput(data);
        } else {
          selectList = showList(fuzzyFilter(items, searchInput.getValue(), (item) => item.label));
        }
      }

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

function reviewerInstructions({ id, adversary, reviewer, rounds }: Review): string {
  return `${adversary} ran the same review as subagent "${id}". Settle every finding with it before you print the final review, by these rules. The rules are added to your first message to it, so don't repeat them yourself. The user's messages reach it only while it's working, so repeat any new ones in your next message to it.

${rules(rounds)}

Each round, you and it reply at the same time to what the other sent in the last round.

1. Call get_subagent_result with agent_id "${id}" and wait: true to collect its review. If it failed, say so and stop, so your review stands.
2. Compare the reviews. Two findings match only if they name the same defect at overlapping lines. A match is agreed, and every other finding is open.
3. Call subagent with resume: "${id}" and run_in_background: true. In the first round, send your findings it didn't raise. After that, send the replies you wrote in the last round.
4. While it works, check the code and reply by the rules to what it sent: in the first round, its findings you didn't raise, and after that, its replies.
5. Call get_subagent_result with agent_id "${id}" and wait: true to collect its replies. A finding is agreed once both of you accept it, and dropped once its author withdraws it.
6. Repeat steps 3 to 5 with only what is still open. Stop after ${rounds} rounds and apply the deadlock rule.
7. Call subagent with resume: "${id}" and no run_in_background, and send the final list and verdict. Fix each place it says they misstate what it agreed to.
8. Print the final review in the format the review instructions ask for, with the human reviewer callouts from both reviews. Start it by saying it replaces your first review, and that findings missing from it were dropped. After each finding's title, say who raised it: both, ${reviewer}, or ${adversary}. For each finding or priority the deadlock rule settled, say so and give each side's position in one sentence.`;
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

  // Returns undefined when the user goes back to the menu.
  async function pickCustom(
    ctx: ExtensionContext,
    provider: string,
    preset: string | undefined,
    saved: string | undefined,
  ): Promise<string | undefined> {
    const choice = await pickModel(ctx, preset, saved);

    if (choice?.save) {
      saveSetting(`superReview/adversaries/${provider}/model`, choice.model);
      loadConfig(ctx);
      ctx.ui.notify(`Default adversary for ${provider}: ${choice.model}`);
    }

    return choice?.model;
  }

  async function ask(
    ctx: ExtensionContext,
    provider: string,
    saved: string | undefined,
  ): Promise<string | undefined> {
    const preset = saved ?? SUGGESTED_MODELS.get(provider);

    const option = await ctx.ui.select(
      "Adversary:",
      preset === undefined
        ? [NO_ADVERSARY, CUSTOM_ADVERSARY]
        : [NO_ADVERSARY, `Adversary (${preset})`, CUSTOM_ADVERSARY],
    );

    if (option === CUSTOM_ADVERSARY) {
      return (await pickCustom(ctx, provider, preset, saved)) ?? ask(ctx, provider, saved);
    }

    return option === undefined || option === NO_ADVERSARY ? undefined : preset;
  }

  async function chooseModel(
    ctx: ExtensionContext,
    provider: string,
    saved: string | undefined,
  ): Promise<string | undefined> {
    return ctx.mode === "tui" ? ask(ctx, provider, saved) : undefined;
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

    const providerSettings = settings.adversaries[session.provider] ?? {};
    const adversary = await chooseModel(ctx, session.provider, providerSettings.model);

    if (adversary !== undefined) {
      pending = {
        service,
        prompt: event.text,
        inheritContext: !emitted.freshSession,
        adversary,
        reviewer: `${session.provider}/${session.id}`,
        thinking: providerSettings.thinking,
        rounds: settings.rounds,
      };
    }
  });

  // Spawns after pi compacts before the prompt and right before agent_start, when pi-subagents
  // starts holding back results until the run settles. If spawn throws, pi reports the error and
  // the review runs without an adversary.
  pi.on("before_agent_start", async (_event, ctx) => {
    const spawn = pending;

    pending = undefined;

    if (spawn === undefined) {
      return;
    }

    // general-purpose with no prompt of its own copies the session's system prompt and tools.
    const id = spawn.service.spawn("general-purpose", spawn.prompt, {
      description: "Super review adversary",
      model: spawn.adversary,
      thinkingLevel: spawn.thinking ?? pi.getThinkingLevel(),
      foreground: false,
      bypassQueue: true,
      inheritContext: spawn.inheritContext,
    });

    review = {
      service: spawn.service,
      id,
      adversary: spawn.adversary,
      reviewer: spawn.reviewer,
      rounds: spawn.rounds,
      consensusStarted: false,
      rulesSent: false,
    };
    ctx.ui.notify(`${spawn.adversary} is reviewing as subagent ${id}.`, "info");
  });

  // The user's messages go to the adversary too.
  pi.on("input", async (event) => {
    if (review !== undefined && event.source !== "extension") {
      await review.service.steer(review.id, event.text);
    }
  });

  // pi-subagents posts results after the run settles, so continuing this run lets the session's
  // model collect the result first.
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

  // Stops an adversary that is still working when the run ends early. After a finished consensus
  // it's idle, and abort does nothing.
  pi.on("agent_settled", async () => {
    if (review !== undefined) {
      review.service.abort(review.id);
    }

    review = undefined;
  });

  pi.on("tool_call", async (event) => {
    if (
      review === undefined ||
      review.rulesSent ||
      event.toolName !== "subagent" ||
      !Value.Check(ResumeCall, event.input) ||
      event.input.resume !== review.id
    ) {
      return;
    }

    review.rulesSent = true;
    event.input.prompt = `${adversaryBriefing(review.rounds)}\n\n---\n\n${event.input.prompt}`;
  });
}
