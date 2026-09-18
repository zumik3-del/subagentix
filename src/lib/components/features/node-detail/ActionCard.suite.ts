/**
 * SSR render suite for ActionCard (task #541).
 *
 * Pins the text/reasoning routing through the shared ToolCallDetail (status dot
 * with `dot-kind-<kind>`, kind name, content block, copy button, no badge-head)
 * and the non-text/reasoning path (badge-head, label, content IoBlock, no copy
 * button via ToolCallDetail). Also asserts the stable `action-<id>` jump id and
 * the `<li>` wrapper with flash support. No DOM runtime, no DB. Uses Vite's SSR
 * module runner.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type ViteDevServer } from 'vite';

type RenderFn = (
	component: unknown,
	options: { props: Record<string, unknown> }
) => { body: string };

let vite: ViteDevServer;
let render: RenderFn;
let ActionCard: unknown;

beforeAll(async () => {
	vite = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'error'
	});
	render = ((await vite.ssrLoadModule('svelte/server')) as { render: RenderFn }).render;
	ActionCard = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/node-detail/ActionCard.svelte'
		)) as { default: unknown }
	).default;
}, 60_000);

afterAll(async () => {
	await vite?.close();
});

function normalizeHtml(html: string): string {
	return html
		.replace(/<!--\[-->/g, '')
		.replace(/<!--[-1]-->/g, '')
		.replace(/<!--\[0-->/g, '')
		.replace(/<!--]-->/g, '')
		.replace(/\bsvelte-[a-z0-9]+/g, '')
		.replace(/class="([^"]*)"/g, (_m, v) => `class="${v.trim()}"`)
		.replace(/\s+/g, ' ')
		.trim();
}

function makeAction(
	overrides: Partial<{
		id: string;
		kind: string;
		at: number;
		endedAt: number | null;
		label: string;
		summary: string;
	}> = {}
) {
	return {
		id: 'a1',
		kind: 'text',
		at: 1_700_000_000_000,
		endedAt: null,
		label: 'text',
		summary: 'hello world',
		...overrides
	};
}

function renderCard(props: Record<string, unknown>): string {
	return render(ActionCard, {
		props: {
			action: makeAction(),
			expanded: {},
			flashId: null,
			onToggleExpanded: () => {},
			...props
		}
	}).body;
}

function makeProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		action: makeAction(),
		expanded: {},
		flashId: null,
		onToggleExpanded: () => {},
		...overrides
	};
}

// --- text / reasoning routing: ToolCallDetail path ----------------------------

describe('ActionCard — text action routes through ToolCallDetail', () => {
	test('renders dot-kind-text and the kind label "text"', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ action: makeAction({ kind: 'text', summary: 'reasoning body' }) }))
		);
		expect(normalized).toContain('dot-kind-text');
		expect(normalized).toContain('>text<');
	});

	test('renders dot-kind-reasoning and the kind label "reasoning"', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ action: makeAction({ kind: 'reasoning', summary: 'thinking' }) }))
		);
		expect(normalized).toContain('dot-kind-reasoning');
		expect(normalized).toContain('>reasoning<');
	});

	test('renders the content block for text actions', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ action: makeAction({ kind: 'text', summary: 'some body text' }) }))
		);
		expect(normalized).toContain('>content<');
		expect(normalized).toContain('>some body text<');
	});

	test('renders the embedded copy button referencing the kind name for text actions', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ action: makeAction({ kind: 'text' }) }))
		);
		expect(normalized).toContain('ui-icon-btn copy');
		expect(normalized).toContain('Copy text call');
	});

	test('does NOT render a ui-badge--text badge for text actions', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ action: makeAction({ kind: 'text' }) }))
		);
		expect(normalized).not.toContain('ui-badge--text');
	});

	test('does NOT render a ui-badge--reasoning badge for reasoning actions', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ action: makeAction({ kind: 'reasoning' }) }))
		);
		expect(normalized).not.toContain('ui-badge--reasoning');
	});
});

// --- Other kinds: badge-head + IoBlock path ----------------------------------

describe('ActionCard — patch action keeps badge-head path', () => {
	test('renders ui-badge--patch with the kind label', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ action: makeAction({ kind: 'patch', label: 'a.ts, b.ts' }) }))
		);
		expect(normalized).toContain('ui-badge--patch');
		expect(normalized).toContain('>patch<');
	});

	test('renders the action label when it differs from the kind', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ action: makeAction({ kind: 'patch', label: 'a.ts, b.ts' }) }))
		);
		expect(normalized).toContain('>a.ts, b.ts<');
	});

	test('renders no copy button (no ToolCallDetail) for patch actions', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ action: makeAction({ kind: 'patch' }) }))
		);
		expect(normalized).not.toContain('ui-icon-btn copy');
	});

	test('renders no dot-kind- class for patch actions', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ action: makeAction({ kind: 'patch' }) }))
		);
		expect(normalized).not.toContain('dot-kind-');
	});
});

describe('ActionCard — agent action keeps badge-head path', () => {
	test('renders ui-badge--agent with the kind label', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ action: makeAction({ kind: 'agent', label: 'developer' }) }))
		);
		expect(normalized).toContain('ui-badge--agent');
		expect(normalized).toContain('>agent<');
	});

	test('renders the label when it differs from kind', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ action: makeAction({ kind: 'agent', label: 'developer' }) }))
		);
		expect(normalized).toContain('>developer<');
	});
});

// --- Stable DOM id and <li> wrapper -------------------------------------------

describe('ActionCard — wrapper structure', () => {
	test('root element is an <li> with the call class', () => {
		const normalized = normalizeHtml(renderCard(makeProps()));
		expect(normalized).toMatch(/<li[^>]*class="[^"]*call[^"]*"/);
	});

	test('jump DOM id is action-<action.id>', () => {
		const html = renderCard(makeProps({ action: makeAction({ id: 'abc123' }) }));
		expect(html).toContain('id="action-abc123"');
	});

	test('flash class is applied when flashId matches the action dom id', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ action: makeAction({ id: 'a1' }), flashId: 'action-a1' }))
		);
		expect(normalized).toContain('class="call action-card flash"');
	});

	test('flash class is absent when flashId does not match', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ action: makeAction({ id: 'a1' }), flashId: 'action-other' }))
		);
		expect(normalized).not.toContain('flash');
		expect(normalized).toContain('class="call action-card"');
	});
});

// --- No regression: ActionCard stays an <li> (required by NodeDetailsList ul) -

describe('ActionCard — no regression in Gantt turn detail', () => {
	test('<li> is the root element for every action kind', () => {
		for (const kind of ['text', 'reasoning', 'patch', 'agent'] as const) {
			const normalized = normalizeHtml(
				renderCard(makeProps({ action: makeAction({ kind }) }))
			);
			expect(normalized.startsWith('<li'), `kind=${kind}`).toBe(true);
		}
	});
});
