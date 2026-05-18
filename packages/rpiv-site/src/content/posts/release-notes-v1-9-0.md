---
title: "Release notes: v1.9.0"
description: "rpiv-advisor learns when to step back without disappearing, and ask-user-question stops hiding the bottom of its own dialog."
pubDate: 2026-05-18T15:00:00Z
author: juicesharp
tags: ["release", "rpiv-advisor", "rpiv-ask-user-question"]
draft: false
---

v1.9.0 is two stories. One closes the loop on a feature that landed
in v1.7.0 — `disabledForModels` was binary, and binary turned out to
be the wrong shape. The other fixes a bug that's been hiding in plain
sight in `ask-user-question` since the day the dialog learned to wrap.

## rpiv-advisor: blocking by effort, not by model

v1.7.0 let `advisor.json` name executor models that should keep the
advisor tool inactive. The rationale held: strong models rarely call
the advisor, and the schema plus description weren't earning their
keep in the prompt cache. But "strong" isn't a property of the model
ID — it's a property of the model plus its reasoning effort. The same
model at `low` effort is a different reviewer than at `xhigh`.

v1.9.0 extends `disabledForModels` to accept object entries with a
`minEffort` threshold:

```json
"disabledForModels": [
  "anthropic:claude-opus-4-7",
  { "model": "zai:glm-5.1", "minEffort": "medium" }
]
```

Plain strings still block at any effort, so existing configs keep
working untouched. Object entries block only when the executor's
effort is at or above `minEffort` — the order is `minimal < low <
medium < high < xhigh`. So you can leave the advisor available when
you're running cheap-and-fast, and have it strip itself out the moment
you crank the reasoning dial up.

The strip/re-add happens immediately on a mid-session effort change.
No restart, no reload — flip the effort picker and the advisor
appears or disappears on the next tool decision.

## rpiv-ask-user-question: the dialog scrolls now

The bug, briefly: `ask_user_question` would render a dialog that's
taller than your terminal, and there was no way to reach the bottom.
The option list windowed at 10, but heading + multi-line option
descriptions + hints + borders could still push past viewport height,
and the dialog never noticed.

v1.9.0 fixes that with a three-region layout. The dialog reads
`tui.terminal.rows`, renders its children at full height, and slices
the result into a sticky top (heading), a scrollable middle (options
and descriptions), and a sticky bottom (hints and the bottom border).
↑/↓ scrolls the focused row into the middle region; overflow
indicators (↑, ↓, or ↕ when only one middle row is available) show
what's still clipped above or below.

The "only one middle row" case is the subtle one — previously the up
arrow would have been silently overwritten by the down arrow. Now the
combined ↕ indicator tells you both directions exist without anyone
having to read the source to figure out why a glyph went missing.

## Anything else?

The other packages in the `@juicesharp/rpiv-*` family bumped to 1.9.0
with no user-visible changes. Two community issues closed with this
release: [#32](https://github.com/juicesharp/rpiv-mono/issues/32)
(the effort-level filter) and
[#33](https://github.com/juicesharp/rpiv-mono/issues/33) (the
clipped dialog). Thanks to the reporters on both.

Grab the new version the usual way:

```sh
npm install @juicesharp/rpiv-pi@1.9.0
```

Or let your normal upgrade flow pick it up. The full per-package
changelog lives in each package's `CHANGELOG.md` in the
[monorepo](https://github.com/juicesharp/rpiv-mono).

See you at v1.10.0.
