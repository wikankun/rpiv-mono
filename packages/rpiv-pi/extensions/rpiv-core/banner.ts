/**
 * Boxed notification banner — the rounded-corner frame used for
 * action-required session notices (missing siblings, agent drift).
 * Pure string rendering; callers pass the result to `ui.notify`.
 */

/**
 * Render `title` and `body` lines inside a rounded box. Width hugs the
 * longest line. Body lines render verbatim — pass `""` for a spacer line.
 *
 * ╭─ title ────────────╮
 * │  body line         │
 * │                    │
 * │  call to action    │
 * ╰────────────────────╯
 */
export function renderBanner(title: string, body: string[]): string {
	const total = Math.max(title.length + 6, ...body.map((l) => l.length + 4));
	const top = `╭─ ${title} ${"─".repeat(total - title.length - 5)}╮`;
	const middle = body.map((l) => `│  ${l.padEnd(total - 4)}│`);
	const bottom = `╰${"─".repeat(total - 2)}╯`;
	return [top, ...middle, bottom].join("\n");
}
