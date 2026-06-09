---
title: "The workflow author's tale"
description: "A short novelette, told from idea to implementation: how you compose a self-checking workflow out of skills, contracts, and channels, and the doors that let it wake to the world, reach into it, and narrate itself back."
pubDate: 2026-06-08T10:00:00Z
author: juicesharp
tags: ["workflow", "contracts", "architecture", "design", "rpiv-workflow"]
draft: false
---

You have a feeling, not yet a plan.

"I want the machine to take a rough feature request, research it, design it, build it, check the work, and commit. And I want it to *stop and fix things* when the review finds problems."

That feeling is a **workflow**. In this framework a workflow is not a script that runs top to bottom. It is a **graph**: a set of named **stages**, and **edges** that say which stage comes after which. You write one by calling `defineWorkflow(...)` with a `name`, a `start`, a set of `stages`, and the `edges` between them. The `name` is what people type to run it. The `start` is where the graph begins.

You haven't written code yet. You've just decided the shape of a journey.

## The first worker

Every stage hires one worker. Usually the worker is a **skill**, a small, self-contained Markdown specialist that knows how to do exactly one job. `research`. `design`. `commit`. (Later we will meet a worker that isn't an AI at all.)

When you write a stage, you choose what *kind* of worker it is. A `produces()` stage makes an **artifact** (a plan, a review, a file) and hands something forward. An `acts()` stage *does* something, like commit or deploy, but hands no artifact forward. The framework calls that a "side-effect" stage.

```ts
stages: {
  research: produces(),
  commit:   acts(),
}
```

You never wrote *how* research works. You named the skill and said what kind of thing it is. The framework dispatches `/skill:research` for you when the stage's turn comes. This is the first quiet power: **you compose specialists, you don't reimplement them.**

## Wiring the journey

Now you connect the stages with **edges**. An edge is just "after this stage, go to that one." The word `"stop"` ends the journey.

```ts
edges: {
  research:  "design",
  design:    "implement",
  implement: "validate",
  validate:  "stop",
}
```

You can already feel the graph. But a worry creeps in. *How does design know what research found?*

## The handoff

Here is the heart of the whole thing.

When a `produces` stage finishes, it drops its artifact into a **rolling slot**, the *primary artifact*. The next stage picks it up automatically. Research writes a doc; design opens it without you wiring a single file path. The baton passes itself.

That works for a straight line. But your idea has a twist. Late in the journey, `implement` doesn't just need the *previous* stage's output. It needs the **plan** written three stages ago, even after a review loop has run twice. A single rolling baton can't remember that.

So the framework gives you a richer handoff: the **named channel**. When a stage declares an outcome with a name, it publishes onto a named shelf, `state.named["plans"]`, which the framework calls a **bucket**. Any later stage asks for that shelf by name with `reads:`.

```ts
blueprint: produces({ outcome: { name: "plans" } }),
implement: acts({ reads: ["plans"] }),
```

`implement` no longer cares who is directly before it. It says "give me the **plans** channel," and gets whatever was last published there, across loops and across non-adjacent stages. **Stages communicate by named channel, not just by adjacency.** The graph can branch and loop, and the data still finds its way.

## What "produces" was hiding

I waved my hand back there. A `produces` stage "made an artifact" and the next stage "picked it up." Let me open it.

When a stage finishes, the framework doesn't grab a file and hope. The stage's **outcome** is a small pairing you control: a **collector** and an optional **parser**. Across a stage, that outcome runs as a four-step sequence:

- **snapshot.** The collector's pre-stage hook remembers the state of the world before the worker starts.
- **collect.** After the worker finishes, the collector gathers what changed (files, a diff, a transcript).
- **parse.** The parser turns the gathered artifacts into clean, structured **data**.
- **finalize.** The runner stamps the record (which stage, when, which run) and seals the envelope.

Remember the world, see what changed, make sense of it, sign it. This is the engine behind every handoff. The messy real-world effect of a stage becomes a tidy `data` object that gates branch on and contracts check.

Picture the `commit` stage. How does the framework know a commit even happened? Its collector **snapshots** `HEAD` before the stage, looks again after to see if `HEAD` moved, and its parser turns "it moved from A to B" into a payload, `{ baselineSha, headSha }`. The stage didn't *say* "I committed." The outcome *observed* it. The framework **measures reality instead of trusting a claim**. And a `produces` stage that promised an artifact and delivered none is caught right here.

## The promise

So far the framework has *moved* things around for you. Now it starts to *understand* them.

Each skill can sign a **contract** in its `SKILL.md` frontmatter, declaring two channels. **`produces`** is what this skill hands out: a `data` shape (a JSON schema), and an opaque tag bag called `meta` (for example `artifactKind: plan`). **`consumes`** is what it needs: a `data` shape it expects, and the named channels it `reads`.

```yaml
contract:
  produces:
    data:
      type: object
      required: [phases, phase_count]
    meta:
      artifactKind: plan
  consumes:
    data:
      status: { const: ready }
```

Read that last line slowly. The `plan` skill is saying: *"I refuse to start until the thing I'm handed is marked `status: ready`."* That is not a comment. The framework will enforce it. A skill is no longer a black box. It is a **specialist with a written job description.**

## The catalog becomes a map

Once every skill has a contract, the collection stops being a pile and becomes a **map**. The framework keeps a **registry** of the contracts and can answer questions of it: which skills produce a `plan`? Which can legally follow `design`? You, or an agent, can assemble a valid journey without reading a word of prose.

But there is a careful rule. The framework deliberately **does not understand your words**. It doesn't know what "plan" *means*. The tag `artifactKind: plan` lives in `meta`, which the framework treats as a sealed envelope. It carries it, and never opens it.

So how can it check that a `plan` producer matches a `plan` consumer if it won't look inside? You teach it, once. You register a tiny **composition comparator** for a channel:

```ts
registerCompositionComparator(
  "plans",
  artifactKindComparator,
)
```

That comparator is the only thing that knows how to compare two `meta` envelopes for the "plans" channel. The engine stays universal. Your meaning stays yours.

## Branches and loops

Back to your original feeling: *stop and fix things when the review finds problems.*

A plain edge goes one way. You need a fork, so instead of a string, the edge becomes a **gate**:

```ts
"code-review": gate("blockers_count", {
  revise: gt(0),
  commit: eq(0),
}),
```

In words: the review stage writes a number, `blockers_count`. Greater than zero, go to `revise`. Zero, go to `commit`. The `gt(0)` and `eq(0)` are **predicates**, tiny yes/no tests over the data the stage produced. And `revise` loops back to `implement`, which loops to `validate`, which loops to `code-review`. The journey now has a heartbeat: build, check, fix, check again, until the review comes back clean, with a built-in bound so it can never spin forever. **Branches and loops are just edges**, and the data decides the path.

## When one worker isn't enough, and when it isn't an AI

Your plan has five phases, each a self-contained slice of work. So you mark `implement` as a **fanout**. The framework reads the plan, finds its phases, and splits that one stage into five **independent units**, each handed its own slice in its own clean session, blind to the others. Its sibling **iterate** is the accumulating version, for when each step needs to see the last. You wrote one stage; the framework spread it into five and joined the results; you never managed the split or the join.

One honest note: under Pi's single-session model the units run one after another, so fanout buys you *isolation and structure*, not raw speed. The units are independent, though, so the day the host runs sessions side by side, they parallelize with nothing to change in your workflow.

And sometimes you don't want a thinker at all. You want a *doer* that runs the same way every time. For that, a stage carries a **`run`** function instead of dispatching a skill. This is a **script stage**, authored with `produces.script` or `acts.script`, and it skips the AI entirely. It is just your TypeScript:

```ts
fetchTickets: produces.script({
  run: async (ctx) => {
    const open = await db.openTickets()
    return {
      kind: "tickets",
      artifacts: [],
      data: { count: open.length },
    }
  },
}),
```

The framework hands your function a **`ScriptContext`**: `ctx.cwd`, `ctx.input` (the upstream envelope), and `ctx.state` (a read-only view of the whole run). The beautiful part: a script stage is a first-class citizen of the same graph. Its `data` flows into the same channels; predicates branch on it; contracts still validate its input. The graph cannot tell, and does not care, whether a stage was an AI musing for thirty seconds or a function that ran in two milliseconds.

## Reaching into the world

This is the door *outward*. Because a script stage is plain code, it can touch anything code can touch: a database, an HTTP API, a queue, an object store. It reads data in, or writes data out.

```ts
postToSlack: acts.script({
  run: async (ctx) => {
    const review = ctx.input?.data
    await slack.send("#builds", review)
  },
}),
```

And here is why that is safe rather than chaotic: whatever a script pulls in from the outside **re-enters through the same typed front door.** It returns `data`, that data is validated against the stage's schema, and only then does it flow onward. The outside world is messy; the moment its data crosses into your workflow, it is measured, shaped, and checked like everything else. Your workflow can now **read from** and **write to** external systems while keeping its contract-checked spine intact.

## Who wakes the journey

Every story needs a beginning. The framework records exactly what pressed *go*, as a **trigger** (`RunTrigger`). There are three kinds. **command**, a person typed `/wf build`. **programmatic**, your own code called `runWorkflow(...)`. **external**, a webhook fired, a cron tick landed, or a sibling tool spawned the run: `{ kind: "external", source: "webhook", ref: "PR-481" }`. That origin is threaded into the run's permanent record and every lifecycle event, so afterward you can filter and route by it.

One honest word, because precision matters. The framework gives you the **vocabulary and plumbing** for triggers. It does not run a webhook server or a cron daemon for you. The listener lives *outside*: a small extension hears the event and calls `runWorkflow` with `trigger: { kind: "external", ... }`. The framework remembers who rang the doorbell; you wire the doorbell. One caution it states plainly: the runtime runs one session at a time, so an external trigger must check that no run is already in flight before it spawns.

## Who's watching

There is one more door, facing the other way: the world listening to the *workflow*. As a run unfolds, the framework fires **lifecycle events** anything can subscribe to: `onWorkflowStart` and `onWorkflowEnd`, `onStageStart` and `onStageEnd`, `onStageRetry` and `onStageError`, `onRoute`, `onFanoutStart` and `onFanoutUnitEnd`. Each carries context: which run, which stage, the trigger that started it all. So an external system can *watch live*: open a progress widget on start, mark a ticket in progress on `onStageEnd`, alert on `onStageError`, close the loop at the end. A trigger lets the world **start** a workflow; a listener lets the world **follow** it.

## The safety net

Here is where authoring stops being hopeful and becomes *safe*.

Before a workflow ever runs, the framework **validates** the whole graph with `validateWorkflow`. It walks every edge and asks hard questions. Does every edge point at a real stage? Is every stage reachable from the start? Does a stage that `reads: ["plans"]` have *someone* who publishes "plans"? And the sharpest question: **does every skill that publishes into a channel actually produce what the reader requires?**

That last check (`checkReadsChannelCompat`) finds **every** stage that publishes a channel, not just the one right before the reader, but the loop-back ones too, and runs your comparator on each. If a producer's `artifactKind` doesn't match what the reader demands, and both sides signed contracts, the workflow is **rejected at authoring time, before a single worker is hired.**

There are really two moments of enforcement, and it is worth knowing which is which. **Load-time** is the *wiring* check ("this graph is shaped wrong"), and it now owns named-channel validity entirely, for every kind of stage. **Run-time** is the *data* check (`ensureContractInputValid`, "this actual artifact failed its promise"), and it is where `status: ready` is enforced as real data flows through. The principle: catch a bad wiring while you are still drawing the map; catch bad data only when the data actually shows up.

## The whole citizen

Step back one last time, and look at what you built, and what you *didn't*.

You wrote a graph of names. You never wrote how to research, design, build, or review. You never wired a file path, managed a work queue, or wrote a join. You declared what each worker promises, taught the framework one comparator for your domain, and pointed some edges backward to make a loop.

And the workflow you got knows how to *live in your world*. It can be **woken** by a webhook or a cron tick. It can **reach out** through script stages to databases and APIs. It can **observe reality** through snapshot-and-collect instead of trusting claims, and **parse** that reality into clean typed data. It can **narrate itself** to anything that is listening. And through every one of those doors (the data a script pulls in, the output an outcome parses, the artifact handed down a channel) the same spine holds: measured, shaped against a contract, checked.

That is the real power. Not a closed machine that runs in the dark, but an **open, self-checking citizen** of your larger system: woken by the world, reaching into the world, honest with the world about what it is doing, while quietly refusing every journey that couldn't possibly work.

You started with a feeling. You ended with a graph that defends itself.

---

*Want the concepts laid out flat, with the API spellings in one place? See [How a workflow works](/docs/explanation/how-a-workflow-works). To hand a real chain to the runner, see [Run a workflow](/docs/guides/run-a-workflow).*
