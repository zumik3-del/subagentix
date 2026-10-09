/**
 * SSR render suite for the shared RefreshButton composite (task #1146).
 *
 * Covers the chronix-parity refresh contract: the Remix `refresh` glyph, the
 * two variants (icon-only circular / labelled `.ui-btn`), `disabled`
 * forwarding, the one-shot `data-rotate` spin, and the call sites that adopted
 * the component.
 *
 * Same constraint as the other component suites: there is no DOM runtime in
 * this repo (no jsdom / happy-dom / Playwright, dependency budget = SvelteKit
 * only, no new dependencies), so the click path cannot be dispatched and
 * timers cannot be advanced. The rendered structure is exercised through
 * `vite.ssrLoadModule` -> `svelte/server` `render()`, and the client-only spin
 * is pinned at the source level — the established convention in
 * `InfiniteScroll.suite.ts` / `scroll-view.suite.ts`. No DOM, no DB.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';

type RenderFn = (
	component: unknown,
	options: { props: Record<string, unknown> }
) => { body: string };

let vite: ViteDevServer;
let render: RenderFn;
let RefreshButton: unknown;
let Icon: unknown;
let iconModule: { ICON_SIZE?: Record<string, number> };
let WidgetCard: unknown;

beforeAll(async () => {
	vite = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'error'
	});
	render = ((await vite.ssrLoadModule('svelte/server')) as { render: RenderFn }).render;
	RefreshButton = (
		await vite.ssrLoadModule('/src/lib/components/composites/RefreshButton.svelte')
	).default;
	const icon = (await vite.ssrLoadModule(
		'/src/lib/components/primitives/Icon.svelte'
	)) as { default: unknown; ICON_SIZE: Record<string, number> };
	Icon = icon.default;
	iconModule = icon;
	WidgetCard = (
		await vite.ssrLoadModule('/src/lib/components/features/dashboard/WidgetCard.svelte')
	).default;
}, 60_000);

afterAll(async () => {
	await vite?.close();
});

// --- HTML normalization (strip Svelte SSR hydration comments and hash suffixes) --

function normalizeHtml(html: string): string {
	return html
		.replace(/<!--\[-->/g, '')
		.replace(/<!--[-1]-->/g, '')
		.replace(/<!--\[0\]-->/g, '')
		.replace(/<!--\]-->/g, '')
		.replace(/\bsvelte-[a-z0-9]+/g, '')
		.replace(/class="([^"]*)"/g, (_m, v) => `class="${v.trim()}"`)
		.replace(/\s+/g, ' ')
		.trim();
}

// --- Fixtures ------------------------------------------------------------------

function renderButton(props: Record<string, unknown> = {}): string {
	return render(RefreshButton, {
		props: { onclick: () => {}, ariaLabel: 'Refresh', ...props }
	}).body;
}

function renderIcon(props: Record<string, unknown>): string {
	return render(Icon, { props }).body;
}

function renderWidgetCard(props: Record<string, unknown> = {}): string {
	return render(WidgetCard, {
		props: { title: 'Cost & tokens', status: 'ready', onRefresh: () => {}, ...props }
	}).body;
}

function source(): string {
	return readFileSync(new URL('./RefreshButton.svelte', import.meta.url), 'utf8');
}

/** Extract the body of a top-level `function name(...)` declaration. */
function functionBody(src: string, name: string): string {
	const start = src.indexOf(`function ${name}(`);
	expect(start).toBeGreaterThan(-1);
	const open = src.indexOf('{', start);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) return src.slice(open + 1, i);
		}
	}
	throw new Error(`unterminated function ${name} in RefreshButton.svelte`);
}

/** Every `.svelte` file under src/, as absolute paths. */
function svelteFilesUnderSrc(): string[] {
	const files: string[] = [];
	// .../src/lib/components/composites/ -> repo root, so `src` is one level in.
	const root = new URL('../../../../', import.meta.url).pathname;
	function walk(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith('.svelte')) files.push(full);
		}
	}
	walk(join(root, 'src'));
	return files;
}

// --- Rendered structure (SSR) ---------------------------------------------------

describe('RefreshButton — icon-only variant', () => {
	test('renders a circular icon control, not a labelled button', () => {
		const html = normalizeHtml(renderButton({ ariaLabel: 'Refresh Cost' }));
		expect(html).toContain('<button type="button"');
		expect(html).toContain('class="ui-icon-btn ui-icon-btn--circle"');
		expect(html).not.toContain('class="ui-btn"');
	});

	test('carries the accessible name and no visible text', () => {
		const html = renderButton({ ariaLabel: 'Refresh Cost', title: 'Refresh' });
		expect(html).toContain('aria-label="Refresh Cost"');
		expect(html).toContain('title="Refresh"');
		// The icon-only variant has no text node — the aria-label is the name.
		expect(normalizeHtml(html)).not.toMatch(/>\s*Refresh\s*</);
	});

	test('renders the glyph at ICON_SIZE.md (16px)', () => {
		expect(iconModule.ICON_SIZE).toEqual({ xs: 12, sm: 14, md: 16, lg: 28 });
		expect(renderButton()).toContain('width="16"');
		expect(renderButton()).toContain('height="16"');
	});
});

describe('RefreshButton — labelled variant', () => {
	test('renders the .ui-btn primitive instead of the circular icon control', () => {
		const html = normalizeHtml(renderButton({ label: 'Reload', ariaLabel: 'Reload' }));
		expect(html).toContain('class="ui-btn"');
		expect(html).not.toContain('ui-icon-btn--circle');
	});

	test('renders the visible label text', () => {
		expect(renderButton({ label: 'Reload', ariaLabel: 'Reload' })).toContain('Reload');
	});

	test('renders the glyph at ICON_SIZE.sm (14px)', () => {
		expect(renderButton({ label: 'Reload', ariaLabel: 'Reload' })).toContain('width="14"');
		expect(renderButton({ label: 'Reload', ariaLabel: 'Reload' })).toContain('height="14"');
	});
});

describe('RefreshButton — disabled is forwarded', () => {
	test('is enabled by default', () => {
		expect(renderButton()).not.toContain('disabled');
	});

	test('forwards disabled={true} onto the button', () => {
		expect(renderButton({ disabled: true })).toContain('disabled=""');
	});

	test('forwards disabled onto the labelled variant too', () => {
		expect(renderButton({ label: 'Reloading…', disabled: true })).toContain('disabled=""');
	});
});

describe('RefreshButton — the refresh glyph (Remix, filled 24-unit)', () => {
	test('uses the 24-unit viewBox with currentColor fill and no stroke', () => {
		const html = renderIcon({ name: 'refresh' });
		expect(html).toContain('viewBox="0 0 24 24"');
		expect(html).toContain('fill="currentColor"');
		expect(html).toContain('stroke="none"');
	});

	test('is a single filled <path>, not a stroked 16-unit glyph', () => {
		const html = renderIcon({ name: 'refresh' });
		expect(html.match(/<path\b/g)?.length ?? 0).toBe(1);
		expect(html).not.toContain('stroke-width');
		expect(html).not.toContain('viewBox="0 0 16 16"');
	});

	test('a non-default size sets both width and height', () => {
		const html = renderIcon({ name: 'refresh', size: 28 });
		expect(html).toContain('width="28"');
		expect(html).toContain('height="28"');
	});

	test('stays decorative for assistive tech', () => {
		const html = renderIcon({ name: 'refresh' });
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain('focusable="false"');
	});
});

// --- One-shot spin: rendered rest state + client-only wiring --------------------

describe('RefreshButton — one-shot spin', () => {
	test('renders no data-rotate at rest (the glyph never spins until a click)', () => {
		expect(renderButton()).not.toContain('data-rotate');
		expect(renderButton({ label: 'Reload' })).not.toContain('data-rotate');
	});

	test('binds data-rotate to the rotating flag, omitted when false', () => {
		expect(source()).toMatch(/data-rotate=\{rotating \? '' : undefined\}/);
	});

	test('a click turns the glyph before invoking the callback', () => {
		// `rotating = true` must precede `onclick()`: a callback that throws (or a
		// fetch that rejects synchronously) must not swallow the click feedback.
		const body = functionBody(source(), 'handleClick');
		expect(body.indexOf('rotating = true')).toBeLessThan(body.indexOf('onclick()'));
	});

	test('animationend is the primary stop signal and clears the flag', () => {
		expect(source()).toMatch(/onanimationend=\{stopSpin\}/);
		const stop = functionBody(source(), 'stopSpin');
		expect(stop).toContain('rotating = false');
		expect(stop).toContain('clearTimeout(spinTimer)');
	});

	test('the 700 ms timer is the fallback for a click whose animationend never fires', () => {
		// animationend never arrives for a prefers-reduced-motion user (the app.css
		// off-rule) nor when the button unmounts mid-spin, so the timer is the
		// guarantee that data-rotate is always cleared.
		expect(source()).toMatch(/const SPIN_MS = 700/);
		const body = functionBody(source(), 'handleClick');
		expect(body).toMatch(/setTimeout\(\(\) => \{\s*rotating = false;\s*\}, SPIN_MS\)/);
	});

	test('a re-click cancels the pending timer instead of stacking a second one', () => {
		const body = functionBody(source(), 'handleClick');
		expect(body.indexOf('clearTimeout(spinTimer)')).toBeLessThan(
			body.indexOf('spinTimer = setTimeout')
		);
	});

	test('unmounting with a pending spin clears the timer', () => {
		// The effect teardown runs on destroy, so a pending setTimeout cannot fire
		// into a torn-down component.
		expect(source()).toMatch(/\$effect\(\(\) => \(\) => clearTimeout\(spinTimer\)\)/);
	});

	test('accepts no loading/spinning prop — the spin is one-shot, never continuous', () => {
		// The chronix contract: the glyph turns once per click and stops, so the
		// control has no in-flight prop of its own. A regression that reintroduces
		// a looping spinner would show up here as an added prop.
		const props = source().match(/interface Props \{[\s\S]*?\n\t\}/)?.[0] ?? '';
		expect(props).toMatch(/onclick:/);
		expect(props).toMatch(/ariaLabel:/);
		expect(props).toMatch(/label\?:/);
		expect(props).toMatch(/title\?:/);
		expect(props).toMatch(/disabled\?:/);
		for (const forbidden of ['loading', 'spinning', 'busy', 'refreshing', 'status']) {
			expect(props).not.toMatch(new RegExp(`\\b${forbidden}\\??:`));
		}
	});
});

// --- Call-site adoption: the component is the only refresh control --------------

describe('RefreshButton — call sites use the shared component', () => {
	const callSites = [
		{ name: 'WidgetCard', url: new URL('./../features/dashboard/WidgetCard.svelte', import.meta.url) },
		{ name: 'SettingsModal', url: new URL('./../features/settings/SettingsModal.svelte', import.meta.url) },
		{ name: 'files/+page.svelte', url: new URL('../../../routes/files/+page.svelte', import.meta.url) }
	];

	for (const site of callSites) {
		const src = readFileSync(site.url, 'utf8');

		test(`${site.name} renders <RefreshButton>`, () => {
			expect(src).toContain('<RefreshButton');
			expect(src).toMatch(/import RefreshButton from '\$lib\/components\/composites\/RefreshButton\.svelte'/);
		});

		test(`${site.name} no longer hand-rolls the glyph or the spin`, () => {
			expect(src).not.toContain('name="refresh"');
			expect(src).not.toContain('is-spinning');
			expect(src).not.toContain('widget-refresh-spin');
			expect(src).not.toContain('data-rotate');
		});
	}
});

describe('RefreshButton — the refresh control is single-sourced', () => {
	const files = svelteFilesUnderSrc().filter(
		(f) => !f.endsWith(join('composites', 'RefreshButton.svelte'))
	);

	test('no .svelte outside RefreshButton.svelte asks Icon for the refresh glyph', () => {
		for (const file of files) {
			expect(readFileSync(file, 'utf8')).not.toContain('name="refresh"');
		}
	});

	test('no .svelte outside RefreshButton.svelte owns the data-rotate marker', () => {
		for (const file of files) {
			expect(readFileSync(file, 'utf8')).not.toContain('data-rotate');
		}
	});

	test('no .svelte declares a bespoke refresh/spin keyframe', () => {
		for (const file of files) {
			const src = readFileSync(file, 'utf8');
			expect(src).not.toMatch(/@keyframes[\s\S]{0,40}?(spin|rotate|refresh)/i);
		}
	});

	test('no emoji refresh glyph anywhere in the UI source', () => {
		for (const file of files) {
			expect(readFileSync(file, 'utf8')).not.toMatch(/[↻⟳🔄🔁]/u);
		}
	});
});

describe('RefreshButton — WidgetCard render contract (SSR)', () => {
	test('the refresh control is the circular icon variant, labelled by the card title', () => {
		const html = renderWidgetCard({ title: 'Cost & tokens' });
		expect(html).toContain('class="ui-icon-btn ui-icon-btn--circle"');
		expect(html).toContain('aria-label="Refresh Cost &amp; tokens"');
		expect(html).toContain('title="Refresh"');
		expect(html).toContain('viewBox="0 0 24 24"');
	});

	test('renders no refresh control when the card has no onRefresh', () => {
		const html = renderWidgetCard({ onRefresh: undefined });
		expect(html).not.toContain('ui-icon-btn--circle');
		expect(html).not.toContain('Refresh Cost');
	});

	test('disables the control while refreshing', () => {
		const html = renderWidgetCard({ refreshing: true });
		expect(html).toMatch(/<button[^>]*class="ui-icon-btn ui-icon-btn--circle"[^>]*disabled=""/);
	});

	test('disables the control while the widget is loading', () => {
		const html = renderWidgetCard({ status: 'loading' });
		expect(html).toMatch(/<button[^>]*class="ui-icon-btn ui-icon-btn--circle"[^>]*disabled=""/);
	});

	test('the enabled control carries no disabled attribute', () => {
		const html = renderWidgetCard({ status: 'ready', refreshing: false });
		expect(html).toContain('ui-icon-btn--circle');
		expect(html).not.toContain('disabled=');
	});
});