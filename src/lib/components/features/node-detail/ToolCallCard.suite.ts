/**
 * SSR render suite for ToolCallCard (tasks #538, #541).
 *
 * Pins the rendered structure: the <li> wrapper with jump DOM id, the flash
 * class, and delegation of the interior (including the copy button) to
 * ToolCallDetail. No DOM runtime, no DB. Uses Vite's SSR module runner.
 */
import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { createServer, type ViteDevServer } from 'vite';

type RenderFn = (
	component: unknown,
	options: { props: Record<string, unknown> }
) => { body: string };

let vite: ViteDevServer;
let render: RenderFn;
let ToolCallCard: unknown;

beforeAll(async () => {
	vite = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'error'
	});
	render = ((await vite.ssrLoadModule('svelte/server')) as { render: RenderFn }).render;
	ToolCallCard = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/node-detail/ToolCallCard.svelte'
		)) as { default: unknown }
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
		.replace(/<!--\[0-->/g, '')
		.replace(/<!--]-->/g, '')
		.replace(/\bsvelte-[a-z0-9]+/g, '')
		.replace(/class="([^"]*)"/g, (_m, v) => `class="${v.trim()}"`)
		.replace(/\s+/g, ' ')
		.trim();
}

// --- Fixture helpers ----------------------------------------------------------

function makeCall(
	overrides: Partial<{
		id: string;
		name: string;
		status: string;
		error: string | null;
		startedAt: number | null;
		input: string | null;
		output: string | null;
		isMcp: boolean;
		isDelegation: boolean;
	}> = {}
) {
	return {
		id: 'c1',
		name: 'bash',
		status: 'completed',
		error: null,
		startedAt: 1_700_000_000_000,
		input: null,
		output: null,
		isMcp: false,
		isDelegation: false,
		...overrides
	};
}

function renderCard(props: Record<string, unknown>): string {
	return render(ToolCallCard, { props }).body;
}

function makeProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		call: makeCall(),
		expanded: {},
		flashId: null,
		nodeStartedAt: 1_700_000_000_000,
		onToggleExpanded: () => {},
		...overrides
	};
}

// --- <li> wrapper, jump id, flash ---------------------------------------------

describe('ToolCallCard — wrapper structure', () => {
	test('root element is an <li> with the call class', () => {
		const normalized = normalizeHtml(renderCard(makeProps()));
		expect(normalized).toMatch(/<li[^>]*class="[^"]*call[^"]*"/);
	});

	test('jump DOM id is tool-call-<call.id>', () => {
		const html = renderCard(makeProps({ call: makeCall({ id: 'abc123' }) }));
		expect(html).toContain('id="tool-call-abc123"');
	});

	test('flash class is applied when flashId matches the call dom id', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ call: makeCall({ id: 'c1' }), flashId: 'tool-call-c1' }))
		);
		expect(normalized).toContain('class="call flash"');
	});

	test('flash class is absent when flashId does not match', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ call: makeCall({ id: 'c1' }), flashId: 'tool-call-different' }))
		);
		expect(normalized).not.toContain('class="call flash"');
		expect(normalized).toContain('class="call"');
	});
});

// --- Delegation to ToolCallDetail ---------------------------------------------

describe('ToolCallCard — delegation to ToolCallDetail', () => {
	test('delegates interior to ToolCallDetail with the merged call view model', () => {
		const html = renderCard(
			makeProps({ call: makeCall({ id: 'c1', name: 'bash', status: 'error', error: 'boom' }) })
		);
		// ToolCallDetail renders the name and error.
		expect(html).toContain('>bash<');
		expect(html).toContain('>boom<');
		expect(html).toContain('dot-err');
	});

	test('the interior copy button is rendered via ToolCallDetail', () => {
		const normalized = normalizeHtml(
			renderCard(makeProps({ call: makeCall({ name: 'read-file' }) }))
		);
		expect(normalized).toContain('ui-icon-btn copy');
		expect(normalized).toContain('Copy read-file call');
	});

	test('passes the resolved start time (call.startedAt fallback to nodeStartedAt)', () => {
		// When call.startedAt is null, the card resolves it to nodeStartedAt.
		const html = renderCard(
			makeProps({ call: makeCall({ id: 'c2', startedAt: null }), nodeStartedAt: 1_700_000_000_500 })
		);
		expect(html).not.toContain('>—<');
	});

	test('call.startedAt is passed through when present', () => {
		const html = renderCard(
			makeProps({ call: makeCall({ id: 'c3', startedAt: 1_700_000_000_100 }) })
		);
		expect(html).not.toContain('>—<');
	});

	test('expanded and onToggleExpanded are forwarded to ToolCallDetail', () => {
		const html = renderCard(
			makeProps({ call: makeCall({ id: 'c4', input: 'hello' }), expanded: { 'c4:input': true } })
		);
		// When expanded, the full input value should be shown.
		expect(html).toContain('>hello<');
	});
});

// --- No regression: Gantt turn detail records ---------------------------------

describe('ToolCallCard — no regression in Gantt turn detail', () => {
	test('<li> is the root element (required by NodeDetailsList ul.calls)', () => {
		const normalized = normalizeHtml(renderCard(makeProps()));
		expect(normalized.startsWith('<li')).toBe(true);
	});
});
