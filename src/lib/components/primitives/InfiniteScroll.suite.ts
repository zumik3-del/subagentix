/**
 * InfiniteScroll primitive suite (task #544).
 *
 * Same constraints as the other component suites: there is no DOM runtime in
 * this repo (no jsdom / happy-dom / Playwright, dependency budget = SvelteKit
 * only) and no new dependencies, so the structure is exercised through
 * `vite.ssrLoadModule` -> `svelte/server` `render()`, while the client-only
 * behaviour (the IntersectionObserver wiring, the busy/`hasMore` guards and
 * observer cleanup) is pinned at the source level — the established convention
 * in `scroll-view.suite.ts` / `m3c-drilldown.suite.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

type RenderFn = (
	component: unknown,
	options: { props: Record<string, unknown> }
) => { body: string };

let vite: ViteDevServer;
let render: RenderFn;
let InfiniteScroll: unknown;

beforeAll(async () => {
	vite = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'error'
	});
	render = ((await vite.ssrLoadModule('svelte/server')) as { render: RenderFn }).render;
	InfiniteScroll = (
		(await vite.ssrLoadModule('/src/lib/components/primitives/InfiniteScroll.svelte')) as {
			default: unknown;
		}
	).default;
}, 60_000);

afterAll(async () => {
	await vite?.close();
});

function renderScroll(props: Record<string, unknown> = {}): string {
	return render(InfiniteScroll, {
		props: { hasMore: true, onReach: () => {}, ...props }
	}).body;
}

function source(): string {
	return readFileSync(new URL('./InfiniteScroll.svelte', import.meta.url), 'utf8');
}

// --- Rendered structure (SSR) -----------------------------------------------

describe('InfiniteScroll — rendered structure', () => {
	test('renders the sentinel and the busy label while loading', () => {
		const html = renderScroll({ busy: true, loadingLabel: 'Loading more…' });
		expect(html).toContain('infinite-scroll__sentinel');
		expect(html).toContain('Loading more…');
		// The busy label is a live region so a screen reader hears the page-in.
		expect(html).toContain('role="status"');
	});

	test('renders the sentinel with no label when idle', () => {
		const html = renderScroll({ busy: false });
		expect(html).toContain('infinite-scroll__sentinel');
		expect(html).not.toContain('Loading');
	});

	test('renders nothing when there are no more pages', () => {
		const html = renderScroll({ hasMore: false });
		expect(html).not.toContain('infinite-scroll');
		expect(html).not.toContain('infinite-scroll__sentinel');
	});

	test('renders an inline alert for a load failure', () => {
		const html = renderScroll({ error: 'Could not load more.' });
		expect(html).toContain('infinite-scroll__error');
		expect(html).toContain('role="alert"');
		expect(html).toContain('Could not load more.');
	});

	test('keeps the error visible even when no more pages remain', () => {
		const html = renderScroll({ hasMore: false, error: 'boom' });
		expect(html).toContain('boom');
		// No sentinel once the list is exhausted.
		expect(html).not.toContain('infinite-scroll__sentinel');
	});

	test('renders the end label only when finished and provided', () => {
		expect(renderScroll({ hasMore: false, endLabel: 'All loaded' })).toContain('All loaded');
		expect(renderScroll({ hasMore: false })).not.toContain('infinite-scroll__end');
	});

	test('applies a caller class to the root', () => {
		expect(renderScroll({ class: 'my-scroll' })).toContain('infinite-scroll my-scroll');
	});
});

// --- Client-only behaviour (source-pinned) ----------------------------------

describe('InfiniteScroll — client behaviour', () => {
	test('guards IntersectionObserver availability before constructing it', () => {
		expect(source()).toMatch(/typeof\s+IntersectionObserver\s*===\s*'undefined'/);
	});

	test('does not observe while busy or when there is nothing more', () => {
		expect(source()).toMatch(/!el\s*\|\|\s*!hasMore\s*\|\|\s*busy/);
	});

	test('disconnects the observer in the effect cleanup', () => {
		expect(source()).toMatch(/observer\.disconnect\(\)/);
	});

	test('calls onReach only on an intersecting entry', () => {
		expect(source()).toMatch(/entries\.some\(\(entry\)\s*=>\s*entry\.isIntersecting\)\)\s*onReach\(\)/);
	});

	test('observes with the configured rootMargin', () => {
		expect(source()).toMatch(/new IntersectionObserver\(/);
		expect(source()).toMatch(/\{\s*rootMargin\s*\}/);
	});
});
