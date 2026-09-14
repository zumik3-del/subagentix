/**
 * Characterization suite for Gantt.svelte and NodeDetailPanel.svelte (task #266).
 *
 * Pins the rendered SSR structure of both feature roots as a stable
 * fingerprint — ordered class-token list + key element counts + pinned
 * attribute values — so every later behavior-preserving extraction step is
 * mechanically verifiable.
 *
 * Svelte scoped-class hashes (e.g. `svelte-abc123`) are stripped and extra
 * whitespace is collapsed before comparison, so the fingerprint is stable
 * across rebuilds.
 *
 * No DOM runtime, no DB, no `$lib/server` imports.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type ViteDevServer } from 'vite';
import type {
	Edge,
	GanttModel,
	Marker,
	Node,
	NodeDetail,
	Step,
	ToolCall,
	Usage
} from '$lib/model/types';

type RenderFn = (
	component: unknown,
	options: { props: Record<string, unknown> }
) => { body: string };

let vite: ViteDevServer;
let render: RenderFn;
let Gantt: unknown;
let Panel: unknown;

beforeAll(async () => {
	vite = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'error'
	});
	render = ((await vite.ssrLoadModule('svelte/server')) as { render: RenderFn }).render;
	Gantt = (
		(await vite.ssrLoadModule('/src/lib/components/features/gantt/Gantt.svelte')) as { default: unknown }
	).default;
	Panel = (
		(await vite.ssrLoadModule('/src/lib/components/features/node-detail/NodeDetailPanel.svelte')) as {
			default: unknown;
		}
	).default;
}, 60_000);

afterAll(async () => {
	await vite?.close();
});

// --- Normalisation helpers ---------------------------------------------------

/**
 * Strip Svelte's auto-generated scoped hashes and collapse whitespace so the
 * fingerprint is stable across rebuilds. Also trims spaces inside class
 * attribute values so `class="foo svelte-1 bar "` normalises to
 * `class="foo bar"`.
 */
function normalizeHtml(html: string): string {
	return html
		.replace(/\bsvelte-[a-z0-9]+/g, '')
		.replace(/class="([^"]*)"/g, (_m, v) => `class="${v.trim()}"`)
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Extract the ordered class-token list for a named element from normalized
 * HTML. Returns `[tag, [token1, token2, ...]]` pairs in document order.
 */
function classTokens(html: string, tag: string): Array<[string, string[]]> {
	const normalized = normalizeHtml(html);
	const re = new RegExp(`<${tag}([^>]*)>`, 'g');
	const out: Array<[string, string[]]> = [];
	for (const match of normalized.matchAll(re)) {
		const attrs = match[1];
		const classMatch = /class="([^"]*)"/.exec(attrs);
		const tokens = classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
		out.push([tag, tokens]);
	}
	return out;
}

/** Count elements whose class attribute contains the exact token `token`. */
function countClass(html: string, token: string): number {
	const normalized = normalizeHtml(html);
	const re = /class="([^"]*)"/g;
	let c = 0;
	for (const m of normalized.matchAll(re)) {
		const tokens = m[1].split(/\s+/);
		if (tokens.includes(token)) c++;
	}
	return c;
}

// --- Fixtures ----------------------------------------------------------------

function usage(overrides: Partial<Usage> = {}): Usage {
	return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, ...overrides };
}

function makeNode(overrides: Partial<Node> = {}): Node {
	return {
		sessionId: 'root1',
		parentSessionId: null,
		agent: 'orchestrator',
		kind: 'orchestrator',
		modelId: 'gpt-5',
		providerId: 'openai',
		depth: 0,
		directory: '/repo/a',
		status: 'completed',
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_010_000,
		running: false,
		flags: [],
		usage: usage({ total: 100, cost: 0.05 }),
		stepCount: 2,
		toolCallCount: 3,
		errorCount: 0,
		compactionCount: 0,
		openStep: false,
		...overrides
	};
}

function makeStep(overrides: Partial<Step> = {}): Step {
	return {
		id: 's1',
		nodeId: 'root1',
		messageId: 'm1',
		index: 0,
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_005_000,
		open: false,
		flags: [],
		reason: 'stop',
		usage: usage({ total: 50, cost: 0.02 }),
		modelId: 'gpt-5',
		hasCompaction: false,
		toolCallIds: ['t1', 't2'],
		...overrides
	};
}

function makeTool(overrides: Partial<ToolCall> = {}): ToolCall {
	return {
		id: 't1',
		nodeId: 'root1',
		stepId: null,
		callId: 'c1',
		name: 'bash',
		status: 'completed',
		error: null,
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_001_000,
		flags: [],
		input: null,
		output: null,
		isMcp: false,
		isDelegation: false,
		trackerRefs: [],
		...overrides
	};
}

function makeMarker(overrides: Partial<Marker> = {}): Marker {
	return { type: 'compaction', nodeId: 'root1', at: 1_700_000_002_000, ...overrides };
}

const T0 = 1_700_000_000_000;

function makeGanttModel(overrides: Partial<GanttModel> = {}): GanttModel {
	const root = makeNode({ sessionId: 'root1', agent: 'orchestrator', kind: 'orchestrator' });
	const child = makeNode({
		sessionId: 'child1',
		parentSessionId: 'root1',
		agent: 'developer',
		kind: 'subagent',
		depth: 1
	});
	const running = makeNode({
		sessionId: 'run1',
		parentSessionId: 'root1',
		agent: 'analyst',
		kind: 'subagent',
		depth: 1,
		running: true,
		endedAt: null
	});
	return {
		turnId: 'turn1',
		rootSessionId: 'root1',
		agent: 'orchestrator',
		t0: T0,
		t1: T0 + 20_000,
		nodes: [root, child, running],
		edges: [
			makeEdge({ id: 'e1', parentNodeId: 'root1', childNodeId: 'child1', startedAt: T0 + 1_000 }),
			makeEdge({ id: 'e2', parentNodeId: 'root1', childNodeId: 'run1', startedAt: T0 + 2_000 })
		],
		steps: [makeStep({ id: 's1', nodeId: 'root1' })],
		toolCalls: [
			makeTool({ id: 't1', nodeId: 'root1', name: 'read', stepId: 's1' }),
			makeTool({ id: 't2', nodeId: 'root1', name: 'mcp_x_recall', stepId: 's1', isMcp: true })
		],
		markers: [makeMarker()],
		actions: [
			{
				id: 'a1',
				nodeId: 'root1',
				kind: 'reasoning',
				at: T0 + 500,
				endedAt: T0 + 600,
				label: 'reasoning',
				summary: 'thinking hard about the problem'
			}
		],
		...overrides
	};
}

function makeEdge(overrides: Partial<Edge> & { id: string; parentNodeId: string }): Edge {
	return {
		childNodeId: null,
		subagentType: null,
		status: 'completed',
		error: null,
		startedAt: null,
		endedAt: null,
		running: false,
		flags: [],
		resultBytes: 0,
		description: null,
		trackerRefs: [],
		...overrides
	};
}

function makeDetail(overrides: Partial<NodeDetail> = {}): NodeDetail {
	return {
		node: makeNode(),
		steps: [makeStep()],
		toolCalls: [
			makeTool({ id: 't1', name: 'read', stepId: 's1', input: 'A'.repeat(650) }),
			makeTool({
				id: 't2',
				name: 'mcp_x_recall',
				stepId: 's1',
				isMcp: true,
				trackerRefs: ['42']
			}),
			makeTool({ id: 't3', name: 'bash', stepId: 's1', status: 'error', error: 'boom' })
		],
		markers: [makeMarker()],
		actions: [
			{
				id: 'a1',
				nodeId: 'root1',
				kind: 'reasoning',
				at: T0 + 500,
				endedAt: T0 + 600,
				label: 'reasoning',
				summary: 'thinking hard about the problem'
			}
		],
		...overrides
	};
}

function renderGantt(model: GanttModel): string {
	return render(Gantt, { props: { model, ziptaskBaseUrl: 'https://zt.example/' } }).body;
}

function renderPanel(detail: NodeDetail): string {
	return render(Panel, { props: { detail, ziptaskBaseUrl: 'https://zt.example/' } }).body;
}

// --- Shared assertion helpers ------------------------------------------------
// Extracted so the "breaks fingerprint" guards can invoke them against
// deliberately-corrupted HTML and prove the assertions actually fire.

function assertGanttFingerprint(n: string): void {
	// Ordered class-token list
	const sectionTokens = classTokens(n, 'section');
	expect(sectionTokens.length).toBeGreaterThanOrEqual(1);
	expect(sectionTokens[0][1]).toContain('gantt');

	const headerTokens = classTokens(n, 'header');
	expect(headerTokens.length).toBeGreaterThanOrEqual(1);
	expect(headerTokens[0][1]).toContain('head');

	const divTokens = classTokens(n, 'div');
	expect(divTokens.find(([, tokens]) => tokens.includes('scroll'))).toBeDefined();
	expect(divTokens.find(([, tokens]) => tokens.includes('labels'))).toBeDefined();

	const chartTokens = classTokens(n, 'svg');
	expect(chartTokens.length).toBeGreaterThanOrEqual(1);
	expect(chartTokens[0][1]).toContain('chart');

	expect(divTokens.find(([, tokens]) => tokens.includes('legend'))).toBeDefined();

	// Key element counts
	expect(n.split('role="button"').length - 1).toBe(3);
	expect(n.split('tabindex="0"').length - 1).toBe(3);
	expect(countClass(n, 'node')).toBe(3);

	const edgePaths = [...n.matchAll(/<path[^>]*d="M [^"]+ C [^"]+"/g)];
	expect(edgePaths.length).toBe(2);

	expect(countClass(n, 'axis-band')).toBe(1);
	expect(countClass(n, 'row-hairline')).toBe(3);
	expect(countClass(n, 'turn-title')).toBe(1);
	expect(countClass(n, 'timing')).toBe(1);
	expect(countClass(n, 'legend')).toBe(1);
	expect(countClass(n, 'legend-group')).toBeGreaterThanOrEqual(2);

	// Pinned attribute values
	expect(n).toContain('role="img"');
	expect(n).toContain('aria-label="Turn wall-clock Gantt"');
	expect(n).toContain('aria-label="orchestrator node root1"');
	expect(n).toContain('aria-label="developer node child1"');
	expect(n).toContain('aria-label="analyst node run1"');

	expect(countClass(n, 'bar-running')).toBe(1);
	expect(n).toContain('fill="url(#running-hatch)"');
	expect(n).toContain('stroke:var(--icon-base)');
	expect(n).toContain('stroke-width="1"');
	expect(n).toContain('scroll-view__viewport--horizontal');
	expect(n).not.toContain('aria-label="Node detail"');
}

function assertPanelFingerprint(n: string): void {
	// Ordered class-token list
	const sectionTokens = classTokens(n, 'section');
	expect(sectionTokens.length).toBeGreaterThanOrEqual(1);
	expect(sectionTokens[0][1]).toContain('panel');

	const divTokens = classTokens(n, 'div');
	expect(divTokens.find(([, tokens]) => tokens.includes('summary-strip'))).toBeDefined();
	expect(divTokens.find(([, tokens]) => tokens.includes('identity'))).toBeDefined();
	expect(divTokens.find(([, tokens]) => tokens.includes('table-scroll'))).toBeDefined();

	// Key element counts
	expect(countClass(n, 'call')).toBe(4);
	expect(countClass(n, 'step-row')).toBe(1);
	expect(countClass(n, 'child-row')).toBe(4);
	expect(countClass(n, 'ui-badge--mcp')).toBe(2);
	expect(countClass(n, 'dot-err')).toBe(2);

	// Pinned attribute values
	expect(n).toContain('Task #42');
	expect(n).toContain('Expand input (650 chars)');
	expect(n).toContain('Show raw JSON');
	expect(n).not.toContain('Hide raw JSON');
	expect(n).not.toContain('No steps or actions recorded');
	expect(n).not.toContain('No tool calls or actions recorded');
	expect(n).toContain('scope="col"');
	expect(n).toContain('col-num');
	expect(n).toContain('col-event');
	expect(n).toContain('col-time');
	expect(n).toContain('>1<');
	expect(n).toContain('placeholder="Filter rows…"');
	expect(n).toContain('aria-label="Filter steps and actions"');
	expect(n).toContain('ui-chip ui-chip--toggle filter');
	expect(n).toContain('aria-label="Node detail"');
}

// --- Gantt fingerprint -------------------------------------------------------

describe('Gantt SSR — structure fingerprint (task #266)', () => {
	test('pins the ordered class-token list, element counts and pinned attributes', () => {
		const n = normalizeHtml(renderGantt(makeGanttModel()));
		assertGanttFingerprint(n);
	});

	test('a removed class token breaks the fingerprint', () => {
		let n = normalizeHtml(renderGantt(makeGanttModel()));
		// Remove the 'gantt' class from the root section — the fingerprint
		// helper must throw when fed this corrupted HTML.
		n = n.replace(/class="gantt"/, 'class=""');
		let threw = false;
		try {
			assertGanttFingerprint(n);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});

// --- NodeDetailPanel fingerprint ---------------------------------------------

describe('NodeDetailPanel SSR — structure fingerprint (task #266)', () => {
	test('pins the ordered class-token list, element counts and pinned attributes', () => {
		const n = normalizeHtml(renderPanel(makeDetail()));
		assertPanelFingerprint(n);
	});

	test('a removed class token breaks the fingerprint', () => {
		let n = normalizeHtml(renderPanel(makeDetail()));
		// Remove the 'panel' class from the root section — the fingerprint
		// helper must throw when fed this corrupted HTML.
		n = n.replace(/class="panel"/, 'class=""');
		let threw = false;
		try {
			assertPanelFingerprint(n);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});

// --- Stability under normalization -------------------------------------------

describe('normalization is stable across rebuilds', () => {
	test('strip removes all svelte-xxx hashes and leaves other classes intact', () => {
		const fixture = '<span class="foo svelte-abc123 bar svelte-xyz789">text</span>';
		const result = normalizeHtml(fixture);
		expect(result).toContain('class="foo bar"');
		expect(result).not.toContain('svelte-');
	});

	test('count works on normalized HTML for structural assertions', () => {
		const html = '<div class="a svelte-1"><span class="b svelte-2"></span><span class="b svelte-3"></span></div>';
		expect(countClass(html, 'b')).toBe(2);
	});
});
