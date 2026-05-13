# rpiv-site — Design System

Sumi ink canvas, washi paper accents, sage/moss/ochre minerals. Two voices: Berkeley Mono for structure, Iowan Old Style for prose. "Ma" rhythm on an 8px grid. Motion is ink-organic, never spring. This document codifies the system already encoded in `src/styles/tokens.css` so the next contributor doesn't have to re-derive it from CSS variables.

## Aesthetic intent (the seven dimensions)

| Dimension | Direction |
|---|---|
| **Tone** | Sumi-e editorial + technical craft. Magazine spread, not SaaS dashboard. |
| **Color** | Dark warm — sumi `#1c1a17` ground, washi `#ede6d3` text, sage/ochre/moss accents. No SaaS blue, no purple gradients. |
| **Typography** | Mono for structure (Berkeley Mono → JetBrains Mono → SF Mono). Serif for prose (Iowan Old Style → Charter → Source Serif). Never Inter, never Roboto, never system-ui as display. |
| **Motion** | Ink-organic `cubic-bezier(0.23, 0.71, 0.27, 0.98)` over five duration tiers (`--dur-fast` 120ms → `--dur-enter` 1200ms). |
| **Spatial** | 8px "ma" rhythm (`--space-1`..`--space-11`). Generous whitespace, asymmetric where it earns it. |
| **Backgrounds** | Solid sumi ground + SumiInk SVG ornament (`corner` / `divider` / `backdrop` variants). No gradient mesh, no noise. |
| **Differentiation** | The sumi/washi material metaphor + the strict mono/serif voice split. |

## Token discipline

Every visual constant lives in `src/styles/tokens.css`. No hex codes, no pixel values, no font-family strings anywhere else in the codebase.

```css
/* WRONG — hex literal in a component */
.card { background: #252220; }

/* RIGHT — token reference */
.card { background: var(--ink-raised); }
```

If a value doesn't exist as a token, **extend `tokens.css` first**, then reference it. The token names carry meaning (`--ink-raised`, `--washi-soft`, `--rule-strong`) that hex values cannot — preserve them.

### Color tokens — when to reach for which

| Surface need | Token |
|---|---|
| Page ground | `--ink` |
| Card / raised surface | `--ink-raised` |
| Muted inset | `--ink-muted` |
| Primary text | `--text` (= `--washi`) |
| Secondary / metadata | `--text-quiet` |
| Tertiary / labels | `--text-distant` |
| Hairline | `--rule` |
| Card edge / emphasis divider | `--rule-strong` |
| Calm accent (links, active state, focus) | `--sage` / `--sage-deep` |
| Warm accent (active border on docs nav, highlight wash) | `--ochre` |
| Deep moss (rare, for severity-low chrome) | `--moss` |
| Chip background | `--kuro` |
| Stop-and-look only (failed verification, severity:critical) | `--alert` — **never as a UI accent** |

### Type tokens

Headings always use `--font-mono`. Body always uses `--font-serif`. Kickers (`.kicker`) are mono uppercase at `--type-tiny` with `letter-spacing: 0.18em`. Don't mix voices within a single element — switch at the element boundary.

### Motion tokens — the budget

Use the named durations, not arbitrary milliseconds:

| Token | When to use |
|---|---|
| `--dur-fast` 120ms | Tap feedback, instant state changes |
| `--dur-quick` 320ms | Hover / focus / active-link migration. **Default for UI feedback.** |
| `--dur-tick` 360ms | Sequenced reveals (stagger ticks) |
| `--dur-ink` 600ms | Slow color migrations on large surfaces |
| `--dur-enter` 1200ms | Hero / page-load signature reveals only |

Always pair durations with `--ease-ink`. Never `ease-in-out`. The `prefers-reduced-motion` override in `tokens.css:91-99` zeros every duration — you get this for free by using the tokens.

## Component patterns

### Atom — typed Props

```astro
---
interface Props { skill: SkillEntry; writeSite?: string }
const { skill, writeSite } = Astro.props;
---
<article class="card">
  <h3>{skill.name}</h3>
</article>

<style>
  .card { background: var(--washi); border: 1px solid var(--rule); }
</style>
```

### Section composer — data-bound

Section composers `await` a typed resolver from `src/lib/` in their frontmatter. **Never call `getCollection()` directly from a component** — the typed adapters in `src/lib/` are the only `astro:content` callers.

### Cross-section ornament — SumiInk

Need an SVG accent? Add a variant to `src/components/SumiInk.astro` (`corner` / `divider` / `backdrop`). Don't create a new SVG component for one-off marks.

## Skinning third-party UI (Pagefind pattern)

Third-party UI components are runtime-injected and Astro's `<style>` block can't scope them. Pattern, as established in `src/components/Search.astro`:

1. **Token bridge** in a scoped `<style>` block — feed the library's CSS variables from `tokens.css`.
2. **Selector overrides** in a `<style is:global>` block — every rule prefixed with the component's mount-point id (`#search`) so nothing leaks.
3. **Specificity** — chain selectors to beat the library's framework-scoped rules. Pagefind uses `.pagefind-ui__x.svelte-xxxx` (0,2,0); `#search .pagefind-ui .pagefind-ui__x` (0,2,1) beats it regardless of stylesheet load order.
4. **Verify the variable name exists** — read the library's compiled CSS before mapping a token. `--pagefind-ui-font-family` looked plausible but was a no-op for months; the actual var is `--pagefind-ui-font`.

When a library doesn't expose a variable for a surface (e.g. Pagefind's `<mark>` highlight), override the raw selector globally with the `#search` prefix. Document the override target inline so the next contributor knows why the rule exists.

## Layout

- **Docs grid**: 240px sidebar / `minmax(0, 1fr)` content / (optional) 180px TOC. Sticky on desktop, drawer on mobile (≤720px).
- **Single scroll context per visual stack**: when a long region (search results, code block) lives inside an already-scrolling container, bound it with `max-height` and its own `overflow-y: auto`. Never stack two `overflow` regions that compete for the wheel.
- **No `max-w-7xl mx-auto` centered-stack defaults**. Sections own their max-width. The standard cap on the docs layout is 1280px.

## NEVER generate

- Default fonts: Inter, Roboto, Arial, system-ui as display type. Avoid the "distinctive but overused" trap too — Space Grotesk, Geist, Satoshi, Fraunces, Cormorant. They show up in every AI demo.
- Clichéd color: purple-to-blue gradients, generic SaaS blue (#3B82F6 family), evenly-distributed pastel palettes.
- Inline visual literals: hex codes, pixel sizes, font names, raw `cubic-bezier(...)` outside `tokens.css`.
- Tailwind utility classes: `max-w-7xl mx-auto`, `rounded-xl shadow-md`, `flex items-center gap-4`. This codebase is vanilla CSS + tokens — keep it.
- Generic motion: `transition: all 200ms ease-in-out`, fade-in on every scroll, identical bounces.
- React/Vue/Svelte islands. The site is pure `.astro` SFCs. No interactive client-side framework.
- `getCollection()` in components — only `src/lib/` adapters call it.
- Inert interactive surfaces: anything that looks clickable must be a real `<a href>` or `<button>`, not a styled `<div>`.

## Cross-references

- Tokens: `src/styles/tokens.css`
- Global primitives (`.kicker`, `.mono`, `.card`, `.chip`, `.container`): `src/styles/global.css`
- Prose styles: `src/styles/prose.css`
- Component architecture: `.rpiv/guidance/packages/rpiv-site/src/components/architecture.md`
- Package architecture: `.rpiv/guidance/packages/rpiv-site/architecture.md`
- Pagefind skin reference: `src/components/Search.astro`
