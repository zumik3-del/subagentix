/**
 * M3c node drill-down render suite (task #196, component task #195).
 *
 * Isolated child process (see `pages.test.ts` for why). There is no DOM test
 * runtime in this repo (no jsdom / happy-dom / Playwright; the POC dependency
 * budget is SvelteKit only), so this suite exercises the two client components
 * through their server renderer:
 *
 *   vite.ssrLoadModule(...) -> svelte/server render(Component, { props })
 *
 * That covers the panel's rendered structure (steps/tool counts, truncation +
 * Expand labels, retry groups, markers, ziptask chips, raw-JSON default state,
 * HTML escaping) and the Gantt's focusable rows / no-panel-before-selection.
 * Interaction that needs a live DOM (clicking Expand / raw JSON, pressing
 * Enter/Space on a row) is asserted at the wiring level only — see the static
 * wiring tests at the end.
 *
 * No DB and no `$lib/server` import: the live opencode DB is never touched.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import type { Edge, GanttModel, Marker, Node, NodeDetail, Step, ToolCall, Usage } from '$lib/model/types';

type RenderFn = (
	component: unknown,
	options: { props: Record<string, unknown> }
) => { body: string };

let vite: ViteDevServer;
let render: RenderFn;
let Panel: unknown;
let Gantt: unknown;
let TaskDetailView: unknown;
let TaskModal: unknown;

beforeAll(async () => {
	vite = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'error'
	});
	const server = (await vite.ssrLoadModule('svelte/server')) as { render: unknown };
	render = server.render as RenderFn;
	Panel = (
		(await vite.ssrLoadModule('/src/lib/components/NodeDetailPanel.svelte')) as {
			default: unknown;
		}
	).default;
	Gantt = (
		(await vite.ssrLoadModule('/src/lib/components/Gantt.svelte')) as {
			default: unknown;
		}
	).default;
	TaskDetailView = (
		(await vite.ssrLoadModule('/src/lib/components/TaskDetailView.svelte')) as {
			default: unknown;
		}
	).default;
	TaskModal = (
		(await vite.ssrLoadModule('/src/lib/components/TaskModal.svelte')) as {
			default: unknown;
		}
	).default;
}, 60_000);

afterAll(async () => {
	await vite?.close();
});

// --- Fixtures ---------------------------------------------------------------

const usage = (overrides: Partial<Usage> = {}): Usage => ({
	input: 0,
	output: 0,
	reasoning: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	cost: 0,
	...overrides
});

function makeNode(overrides: Partial<Node> = {}): Node {
	return {
		sessionId: 'root1',
		parentSessionId: null,
		agent: 'build',
		kind: 'orchestrator',
		modelId: 'gpt-5',
		providerId: 'openai',
		depth: 0,
		directory: '/repo/a',
		status: 'completed',
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_005_000,
		running: false,
		flags: [],
		usage: usage({ total: 3, cost: 0.25 }),
		stepCount: 0,
		toolCallCount: 0,
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
		endedAt: 1_700_000_001_500,
		open: false,
		flags: [],
		reason: 'stop',
		usage: usage({ total: 3, cost: 0.25 }),
		modelId: 'gpt-5',
		hasCompaction: false,
		toolCallIds: [],
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

function makeDetail(overrides: Partial<NodeDetail> = {}): NodeDetail {
	return { node: makeNode(), steps: [], toolCalls: [], markers: [], ...overrides };
}

function renderPanel(detail: NodeDetail, ziptaskBaseUrl: string | null = null): string {
	return render(Panel, { props: { detail, ziptaskBaseUrl } }).body;
}

function renderGantt(model: GanttModel, ziptaskBaseUrl: string | null = null): string {
	return render(Gantt, { props: { model, ziptaskBaseUrl } }).body;
}

function renderDetail(detail: unknown): string {
	return render(TaskDetailView, { props: { detail } }).body;
}

function makeModel(overrides: Partial<GanttModel> = {}): GanttModel {
	return {
		turnId: 'root1_u1',
		rootSessionId: 'root1',
		agent: 'build',
		t0: 1_700_000_000_000,
		t1: 1_700_000_010_000,
		nodes: [makeNode()],
		edges: [],
		steps: [],
		toolCalls: [],
		markers: [],
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

// A 610-char payload whose tail must never reach the rendered HTML once truncated.
const LONG_INPUT = `${'A'.repeat(600)}TAILSECRET`;

// --- Panel structure --------------------------------------------------------

describe('NodeDetailPanel SSR — steps and tool/MCP calls', () => {
	test('renders the node header and the step/tool counts', () => {
		const html = renderPanel(
			makeDetail({
				steps: [makeStep({ id: 's1', index: 0 }), makeStep({ id: 's2', index: 1 })],
				toolCalls: [
					makeTool({ id: 't1', name: 'bash' }),
					makeTool({ id: 't2', name: 'read' }),
					makeTool({ id: 't3', name: 'mcp_x_recall', isMcp: true })
				]
			})
		);
		expect(html).toContain('aria-label="Node detail"');
		expect(html).toContain('main node');
		expect(html).toContain('root1');
		expect(html).toContain('orchestrator');
		expect(html).toContain('completed');
		expect(html).toContain('gpt-5');
		expect(html).toContain('Steps &amp; actions (');
		expect(html).toContain('Details (3)');
	});

	test('marks an open step and shows the empty states for an empty slice', () => {
		// #230: step number is derived from the loop index (stepNo+1), not step.index.
		// A single step at array position 0 renders "1 · open" regardless of step.index.
		const open = renderPanel(makeDetail({ steps: [makeStep({ index: 1, open: true, endedAt: null })] }));
		expect(open).toContain('1 · open'); // stepNo=0 → row 1
		expect(open).toContain('running');

		const empty = renderPanel(makeDetail());
		expect(empty).toContain('No steps or actions recorded for this node.');
		expect(empty).toContain('No tool calls or actions recorded for this node.');
		expect(empty).toContain('No compaction or removed-content markers.');
	});

	test('renders MCP and error styling from the tool vocabulary', () => {
		const html = renderPanel(
			makeDetail({
				toolCalls: [
					makeTool({ id: 't1', name: 'mcp_x_recall', isMcp: true, status: 'completed' }),
					makeTool({ id: 't2', name: 'task', isDelegation: true, status: 'error', error: 'boom' })
				]
			})
		);
		expect(html).toContain('ui-badge--mcp');
		expect(html).toContain('ui-badge--deleg');
		expect(html).toContain('dot-err');
		expect(html).toContain('boom');
	});
});

describe('NodeDetailPanel SSR — summary strip above Steps (task #223)', () => {
	test('renders Retries | Markers | Tracker links | Permissions as a 4-column strip before the Steps table', () => {
		const html = renderPanel(
			makeDetail({
				steps: [makeStep({ id: 's1', index: 0 }), makeStep({ id: 's2', index: 1 })],
				toolCalls: [
					makeTool({ id: 't1', name: 'bash', startedAt: 100 }),
					makeTool({ id: 't2', name: 'bash', status: 'error', error: 'x', startedAt: 200 })
				],
				markers: [{ type: 'compaction', nodeId: 'root1', at: 1_700_000_001_000 }]
			}),
			'https://zt.example'
		);
		// One strip carrying exactly four columns.
		const classTokens = [...html.matchAll(/class="([^"]*)"/g)].map((match) =>
			match[1].split(/\s+/)
		);
		expect(classTokens.filter((tokens) => tokens.includes('summary-strip')).length).toBe(1);
		expect(classTokens.filter((tokens) => tokens.includes('summary-col')).length).toBe(4);
		// All four headings render, including the empty tracker/permission states.
		expect(html).toContain('Retries (1)');
		expect(html).toContain('Markers (1)');
		expect(html).toContain('Tracker links');
		expect(html).toContain('No tracker link.');
		expect(html).toContain('Permissions (0)');
		expect(html).toContain('No permission prompts recorded.');
		// The strip precedes the Steps table in document order.
		expect(html.indexOf('summary-strip')).toBeLessThan(html.indexOf('Steps &amp; actions ('));
	});

	test('all four columns always render; empty Retries shows the muted placeholder', () => {
		const html = renderPanel(makeDetail());
		expect(html).toContain('Retries (0)');
		expect(html).toContain('No retries.');
		expect(html).toContain('Markers (0)');
		expect(html).toContain('No compaction or removed-content markers.');
		expect(html).toContain('Tracker links');
		expect(html).toContain('No tracker link.');
		expect(html).toContain('Permissions (0)');
		expect(html).toContain('No permission prompts recorded.');
	});

	test('the strip is a responsive auto-fit grid (source)', () => {
		const panel = componentSource('../lib/components/NodeDetailPanel.svelte');
		expect(panel).toContain('class="summary-strip"');
		expect(panel).toMatch(
			/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(14rem,\s*1fr\)\)/
		);
	});
});

describe('NodeDetailPanel SSR — merged Steps & actions table', () => {
	test('adds non-tool actions as rows next to the steps', () => {
		const html = renderPanel(
			makeDetail({
				steps: [makeStep({ id: 's1', index: 0 })],
				toolCalls: [makeTool({ id: 't1', name: 'bash', stepId: 's1', input: '{"command":"ls"}' })],
				actions: [
					{
						id: 'a1',
						nodeId: 'root1',
						kind: 'reasoning',
						at: 1_700_000_000_100,
						endedAt: null,
						label: 'reasoning',
						summary: 'thinking hard'
					},
					{
						id: 'a2',
						nodeId: 'root1',
						kind: 'patch',
						at: 1_700_000_000_200,
						endedAt: null,
						label: 'patch',
						summary: '/x.ts'
					}
				]
			})
		);
		expect(html).toContain('Steps &amp; actions (');
		expect(html).toContain('ui-badge--reasoning');
		expect(html).toContain('ui-badge--patch');
		expect(html).toContain('thinking hard');
		expect(html).toContain('Filter steps and actions');
		// Action rows carry a clickable simple name and a detail anchor.
		expect(html).toContain('action-link');
		expect(html).toContain('id="action-a1"');
		expect(html).toContain('id="action-a2"');
		// Tool calls stay Reason links inside the step, not separate rows.
		expect(html).toContain('reason-link');
	});

	test('carries the permission prompt onto the tool row and summary column', () => {
		const html = renderPanel(
			makeDetail({
				steps: [makeStep({ id: 's1', index: 0 })],
				toolCalls: [
					makeTool({
						id: 't9',
						name: 'bash',
						stepId: 's1',
						permission: {
							requestId: 'per_1',
							permission: 'bash',
							patterns: ['rm*'],
							reply: 'reject',
							askedAt: 1,
							repliedAt: 2
						}
					})
				]
			})
		);
		expect(html).toContain('Permissions (1)');
		expect(html).toContain('ui-badge--perm');
		expect(html).toContain('permission: reject');
		expect(html).toContain('ask: reject');
	});
});

describe('NodeDetailPanel SSR — Steps Reason column (task #218)', () => {
	test('renders the step tool summary as a Reason button and marks errors', () => {
		const html = renderPanel(
			makeDetail({
				steps: [makeStep({ id: 's1', index: 0 })],
				toolCalls: [
					makeTool({ id: 't1', stepId: 's1', name: 'read', startedAt: 100 }),
					makeTool({ id: 't2', stepId: 's1', name: 'bash', startedAt: 200 }),
					makeTool({
						id: 't3',
						stepId: 's1',
						name: 'bash',
						status: 'error',
						error: 'boom',
						startedAt: 300
					}),
					makeTool({ id: 't4', stepId: 's1', name: 'grep', startedAt: 400 })
				]
			})
		);
		expect(html).toContain('reason-link');
		expect(html).toContain('read, bash ×2, grep');
		expect(html).toContain('· 1 err');
	});

	test('attributes a step call only via the step toolCallIds list (stepId is null)', () => {
		const html = renderPanel(
			makeDetail({
				steps: [makeStep({ id: 's1', index: 0, toolCallIds: ['t1'] })],
				// The call carries no `stepId`: only the step's id list attributes it.
				toolCalls: [makeTool({ id: 't1', stepId: null, name: 'bash' })]
			})
		);
		expect(html).toContain('reason-link');
		// The Reason cell (button title/aria-label) shows the attributable tool,
		// proving the shared `stepCalls` predicate picked up the toolCallIds-only call.
		expect(html).toContain('Step 1: bash (1 tool call)');
		expect(html).not.toContain('· 1 err');
	});

	test('a step with no calls renders an em dash and no reason button', () => {
		const html = renderPanel(makeDetail({ steps: [makeStep({ id: 's1', index: 0 })], toolCalls: [] }));
		expect(html).toContain('—');
		expect(html).not.toContain('reason-link');
	});

	test('the steps table no longer exposes a Model column or the step model id', () => {
		const html = renderPanel(
			makeDetail({
				node: makeNode({ modelId: 'node-llm' }),
				steps: [makeStep({ id: 's1', index: 0, modelId: 'step-llm' })],
				toolCalls: [makeTool({ id: 't1', stepId: 's1', name: 'read' })]
			})
		);
		expect(html).not.toContain('>Model<');
		expect(html).not.toContain('step-llm');
		// The node-level model chip is unrelated and still renders.
		expect(html).toContain('node-llm');
	});
});

describe('NodeDetailPanel SSR — truncation and Expand', () => {
	test('long input is truncated and offers an Expand button with the original length', () => {
		const html = renderPanel(makeDetail({ toolCalls: [makeTool({ input: LONG_INPUT })] }));
		expect(html).toContain('Expand input (610 chars)');
		expect(html).toContain('…');
		// The tail past the 600-char budget is not in the rendered HTML.
		expect(html).not.toContain('TAILSECRET');
	});

	test('long output is truncated independently from the input', () => {
		const html = renderPanel(
			makeDetail({ toolCalls: [makeTool({ input: 'short', output: 'B'.repeat(700) })] })
		);
		expect(html).toContain('Expand output (700 chars)');
		// input is short -> no input Expand button.
		expect(html).not.toContain('Expand input');
	});

	test('short input/output render in full with no Expand button', () => {
		const html = renderPanel(makeDetail({ toolCalls: [makeTool({ input: 'short in', output: 'short out' })] }));
		expect(html).toContain('short in');
		expect(html).toContain('short out');
		expect(html).not.toContain('Expand input');
		expect(html).not.toContain('Expand output');
	});
});

describe('NodeDetailPanel SSR — retries and markers', () => {
	test('groups repeated tool invocations and flags the error', () => {
		const html = renderPanel(
			makeDetail({
				toolCalls: [
					makeTool({ id: 't1', name: 'bash', status: 'completed', startedAt: 100 }),
					makeTool({ id: 't2', name: 'bash', status: 'error', error: 'x', startedAt: 200 }),
					makeTool({ id: 't3', name: 'read', startedAt: 300 })
				]
			})
		);
		expect(html).toContain('Retries (1)');
		expect(html).toContain('2 invocations · 1 retry · includes error');
	});

	test('renders compaction (timestamped) and removed (no timestamp) markers', () => {
		const markers: Marker[] = [
			{ type: 'compaction', nodeId: 'root1', at: 1_700_000_001_000 }, // 22:13:21 UTC
			{ type: 'removed', nodeId: 'root1', at: null }
		];
		const html = renderPanel(makeDetail({ markers }));
		expect(html).toContain('Markers (2)');
		expect(html).toContain('ui-badge--compaction');
		expect(html).toContain('ui-badge--removed');
		expect(html).toContain('context summarization at 22:13:21');
		expect(html).toContain('removed content (no timestamp)');
	});

	test('always keeps the Retries column with a muted placeholder when nothing repeats', () => {
		const html = renderPanel(makeDetail({ toolCalls: [makeTool({ name: 'bash' })] }));
		expect(html).toContain('Retries (0)');
		expect(html).toContain('No retries.');
	});
});

describe('NodeDetailPanel SSR — inferred ziptask chips', () => {
	test('dedupes refs and renders each as a modal-opening button', () => {
		const html = renderPanel(
			makeDetail({
				toolCalls: [
					makeTool({ id: 't1', trackerRefs: ['185', '42'] }),
					makeTool({ id: 't2', trackerRefs: ['185'] })
				]
			}),
			'https://zt.example/'
		);
		expect(html).toContain('Task #185');
		expect(html).toContain('Task #42');
		expect(html).toContain('<button type="button" class="ui-chip ui-chip--link');
		expect(html.split('Task #185').length - 1).toBe(1);
	});

	test('does not build an external href from the configured base', () => {
		const html = renderPanel(
			makeDetail({ toolCalls: [makeTool({ trackerRefs: ['7'] })] }),
			'https://zt.example///'
		);
		expect(html).not.toContain('/task/');
		expect(html).not.toContain('href=');
	});

	test('shows the not-configured state when refs exist but the base URL is unset', () => {
		const html = renderPanel(makeDetail({ toolCalls: [makeTool({ trackerRefs: ['7'] })] }), null);
		expect(html).toContain('ZIPTASK_BASE_URL is not configured.');
		expect(html).not.toContain('/task/7');
	});

	test('shows the no-link state when nothing is inferred', () => {
		const html = renderPanel(makeDetail({ toolCalls: [makeTool()] }), 'https://zt.example');
		expect(html).toContain('No tracker link.');
	});
});

// --- Task detail modal (feature #263) ----------------------------------------

describe('TaskDetailView SSR — meta, description and comments', () => {
	const taskDetail = (overrides: Record<string, unknown> = {}, comments: unknown[] = []) => ({
		task: {
			id: 185,
			title: 'Ship the modal',
			description: 'Body text\nsecond line',
			status: 'done',
			priority: 'p1',
			assignee: 'developer',
			reporter: 'orchestrator',
			attempts: 1,
			maxAttempts: 3,
			createdAt: '2026-09-13T05:36:28.320Z',
			updatedAt: '2026-09-13T06:14:23.159Z',
			completedAt: '2026-09-13T06:14:23.159Z',
			isEpic: false,
			epicId: null,
			...overrides
		},
		comments
	});

	test('renders the title, meta fields and the description', () => {
		const html = renderDetail(taskDetail());
		expect(html).toContain('Ship the modal');
		expect(html).toContain('Status');
		expect(html).toContain('done');
		expect(html).toContain('Priority');
		expect(html).toContain('p1');
		expect(html).toContain('developer');
		expect(html).toContain('2026-09-13 05:36:28'); // created_at in UTC
		expect(html).toContain('Body text\nsecond line');
	});

	test('renders comments as blocks with agent, type and content', () => {
		const html = renderDetail(
			taskDetail({}, [
				{ id: 1, agent: 'system', content: 'the spec', type: 'comment', createdAt: '2026-09-13T05:36:28.326Z' },
				{ id: 2, agent: 'orchestrator', content: 'done', type: 'resolution', createdAt: '2026-09-13T06:14:23.164Z' }
			])
		);
		expect(html).toContain('Comments (2)');
		expect(html).toContain('system');
		expect(html).toContain('the spec');
		expect(html).toContain('resolution');
		expect(html).toContain('orchestrator');
		expect(html).toContain('done');
		// The default `comment` type is not shown as a badge.
		expect(html).not.toMatch(/<span class="type">comment<\/span>/);
	});

	test('shows empty states for a task without a description or comments', () => {
		const html = renderDetail(taskDetail({ description: null }));
		expect(html).toContain('No description.');
		expect(html).toContain('Comments (0)');
		expect(html).toContain('No comments.');
	});

	test('marks an epic and shows its epic id', () => {
		const html = renderDetail(taskDetail({ isEpic: true, epicId: 42 }));
		expect(html).toContain('epic');
		expect(html).toContain('#42');
	});
});

describe('TaskModal SSR — dialog shell and loading state', () => {
	test('renders an accessible dialog in the loading state before the fetch runs', () => {
		const html = render(TaskModal, { props: { id: '185' } }).body;
		expect(html).toContain('role="dialog"');
		expect(html).toContain('aria-modal="true"');
		expect(html).toContain('Task #185');
		expect(html).toContain('Loading…');
	});
});

describe('NodeDetailPanel SSR — raw JSON, escaping and raw-HTML hygiene', () => {
	test('raw JSON is collapsed by default', () => {
		const html = renderPanel(makeDetail());
		expect(html).toContain('Show raw JSON');
		expect(html).not.toContain('Hide raw JSON');
		expect(html).not.toContain('<pre class="raw"');
	});

	test('renders nothing that could inject raw HTML from tool text', () => {
		const html = renderPanel(
			makeDetail({
				toolCalls: [
					makeTool({
						id: 't1',
						input: '<img src=x onerror=alert(1)>',
						output: '<svg onload=alert(1)>',
						error: '<script>alert(1)</script>'
					})
				]
			})
		);
		// Svelte SSR escapes the leading `<` of each markup token; the remaining
		// `>` is inert, so the payload can never open a tag.
		expect(html).toContain('&lt;img src=x onerror=alert(1)>');
		expect(html).toContain('&lt;svg onload=alert(1)>');
		expect(html).toContain('&lt;script>alert(1)&lt;/script>');
		expect(html).not.toContain('<img src=x');
		expect(html).not.toContain('<svg onload=');
		expect(html).not.toContain('<script>alert');
	});
});

// --- Gantt selection surface ------------------------------------------------

describe('Gantt SSR — focusable rows and no panel before selection', () => {
	test('every node row is a focusable button and the drill-down panel is absent', () => {
		const html = renderGantt(
			makeModel({
				nodes: [
					makeNode({ sessionId: 'root1', agent: 'build' }),
					makeNode({ sessionId: 'child1', parentSessionId: 'root1', depth: 1, kind: 'subagent', agent: 'developer' })
				]
			})
		);
		// Header card: turn label + totals on the left, time range on the right.
		expect(html).toMatch(/class="turn-title/);
		expect(html).toContain('→');
		expect(html).not.toContain('nodes');
		expect(html).not.toContain('delegation edges');
		expect(html.split('role="button"').length - 1).toBe(2);
		expect(html.split('tabindex="0"').length - 1).toBe(2);
		expect(html).toContain('aria-label="main node root1"');
		expect(html).toContain('aria-label="developer node child1"');
		// Selection is client state: the panel must not render before a row is chosen.
		expect(html).not.toContain('aria-label="Node detail"');
		expect(html).not.toContain('selected ');
	});
});

// --- Static wiring (no DOM runtime available) -------------------------------

function componentSource(relative: string): string {
	return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('client source wiring — keyboard, selection and raw-HTML hygiene', () => {
	const gantt = componentSource('../lib/components/Gantt.svelte');
	const panel = componentSource('../lib/components/NodeDetailPanel.svelte');

	test('Gantt rows bind Enter/Space to selection with preventDefault', () => {
		expect(gantt).toContain('onkeydown={(event) => onRowKey(event, row.node.sessionId)}');
		expect(gantt).toContain('function onRowKey(event: KeyboardEvent, nodeId: string)');
		expect(gantt).toContain("event.key === 'Enter' || event.key === ' '");
		expect(gantt).toContain('event.preventDefault()');
		expect(gantt).toContain('selectNode(nodeId)');
		expect(gantt).toContain('onclick={() => selectNode(row.node.sessionId)}');
	});

	test('Gantt marks the selected row/node and renders the panel from the selection', () => {
		expect(gantt).toContain('class:active={row.active}');
		expect(gantt).toContain('{#if selectedDetail}');
		expect(gantt).toContain('<NodeDetailPanel');
	});

	test('the panel Expand / raw-JSON toggles render the full value when active', () => {
		expect(panel).toContain('onclick={() => toggleExpanded(`${call.id}:input`)}');
		expect(panel).toContain('onclick={() => toggleExpanded(`${call.id}:output`)}');
		expect(panel).toContain('? call.input : input.text');
		expect(panel).toContain('? call.output : output.text');
		expect(panel).toContain('onclick={() => (showRaw = !showRaw)}');
		expect(panel).toContain('{#if showRaw}');
	});

	test('neither client component uses {@html} or imports server-only modules', () => {
		for (const [name, source] of [
			['Gantt.svelte', gantt],
			['NodeDetailPanel.svelte', panel]
		] as const) {
			expect(`${name}:${/@html/.test(source)}`).toBe(`${name}:false`);
			const imports = source
				.split('\n')
				.filter((line) => /^\s*import\b/.test(line))
				.join('\n');
			expect(`${name}:${/\$lib\/server|bun:sqlite|opencode\.db|OPENCODE_DB/.test(imports)}`).toBe(
				`${name}:false`
			);
		}
	});
});

describe('client source wiring — Reason step scroll (task #218, scroll-only in #223)', () => {
	const panel = componentSource('../lib/components/NodeDetailPanel.svelte');

	test('the Reason button is wired to focusStep for the step', () => {
		expect(panel).toContain('class="ui-link-btn reason-link"');
		expect(panel).toContain('onclick={() => focusStep(step.id)}');
		expect(panel).toContain('async function focusStep(stepId: string)');
	});

	test('focusStep ticks, then scrolls the first attributed call into view', () => {
		expect(panel).toContain('const first = stepCalls(stepId)[0];');
		expect(panel).toContain('await tick()');
		expect(panel).toContain('scrollIntoView({');
		expect(panel).toContain("block: 'center'");
		// Reduced-motion users get an instant jump instead of a smooth scroll.
		expect(panel).toContain(
			"window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'"
		);
	});

	test('the old highlight wiring is fully removed', () => {
		for (const token of [
			'focusedStepId',
			'focusedCalls',
			'focusedCallIds',
			'class:focused',
			'call.stepId === focusedStepId'
		]) {
			expect(`${token}:${panel.includes(token)}`).toBe(`${token}:false`);
		}
		// No `.focused` styling hook survives in the panel styles.
		expect(panel).not.toMatch(/\.focused\b/);
	});

	test('tool-call rows keep stable jump ids but carry no focus class', () => {
		expect(panel).toContain('id={callDomId(call.id)}');
		expect(panel).toContain('function callDomId(id: string): string');
		expect(panel).not.toContain('class:focused');
	});

	test('attribution stays the single shared stepCalls predicate', () => {
		expect(panel).toContain('call.stepId === stepId || step.toolCallIds.includes(call.id)');
	});
});

// --- Task #230: Steps numbering, per-call Reason buttons, copy + clipboard ------

describe('NodeDetailPanel SSR — Steps numbered by list position (task #230)', () => {
	test('multiple steps render sequential numbers 1,2,3 regardless of step.index', () => {
		const html = renderPanel(
			makeDetail({
				steps: [
					makeStep({ id: 's1', index: 5 }),
					makeStep({ id: 's2', index: 2 }),
					makeStep({ id: 's3', index: 99 })
				]
			})
		);
		// stepNo+1 from the `{#each ... as step, stepNo}` loop, NOT step.index.
		expect(html).toContain('>1<');
		expect(html).toContain('>2<');
		expect(html).toContain('>3<');
		// The raw step.index values must not appear anywhere in the rendered HTML.
		expect(html).not.toContain('>5<');
		expect(html).not.toContain('>99<');
	});

	test('a single step with non-zero index still renders "1"', () => {
		const html = renderPanel(
			makeDetail({ steps: [makeStep({ id: 's1', index: 7 })] })
		);
		expect(html).toMatch(/<td class="svelte-[^"]*">1[^<]*<\/td>/);
	});

	test('Reason tooltip uses list position, not step.index, for each step', () => {
		const html = renderPanel(
			makeDetail({
				steps: [
					makeStep({ id: 's1', index: 5, toolCallIds: ['t1'], reason: null }),
					makeStep({ id: 's2', index: 2, toolCallIds: ['t2'], reason: null }),
					makeStep({ id: 's3', index: 99, toolCallIds: ['t3'], reason: null })
				],
				toolCalls: [
					makeTool({ id: 't1', stepId: null, name: 'bash' }),
					makeTool({ id: 't2', stepId: null, name: 'read' }),
					makeTool({ id: 't3', stepId: null, name: 'grep' })
				]
			})
		);
		// The `#` column (row number) uses stepNo+1.
		expect(html).toContain('>1<');
		expect(html).toContain('>2<');
		expect(html).toContain('>3<');
		// The Reason tooltip/title also uses stepNo+1, matching the `#` column.
		expect(html).toContain('title="Step 1: bash (1 tool call)"');
		expect(html).toContain('title="Step 2: read (1 tool call)"');
		expect(html).toContain('title="Step 3: grep (1 tool call)"');
		// DB index values must NOT leak into tooltips.
		expect(html).not.toContain('Step 6:');
		expect(html).not.toContain('Step 100:');
	});
});

describe('NodeDetailPanel SSR — Reason cell: one button per call, no ×N collapse (task #230)', () => {
	test('the Reason cell renders one <button> per attributed call, not a collapsed ×N summary', () => {
		const html = renderPanel(
			makeDetail({
				steps: [makeStep({ id: 's1', index: 0, toolCallIds: ['t1', 't2'] })],
				toolCalls: [
					makeTool({ id: 't1', stepId: null, name: 'bash' }),
					makeTool({ id: 't2', stepId: null, name: 'read' })
				]
			})
		);
		// Two separate reason-link buttons, one per call.
		expect(html.split('reason-link').length - 1).toBe(2);
		// Each button carries the call's name as visible text.
		expect(html).toContain('>bash<');
		expect(html).toContain('>read<');
		// No ×N collapsed label in the Reason cell.
		expect(html).not.toContain('×2');
	});

	test('a step with a single call renders exactly one reason-link button', () => {
		const html = renderPanel(
			makeDetail({
				steps: [makeStep({ id: 's1', index: 0, toolCallIds: ['t1'] })],
				toolCalls: [makeTool({ id: 't1', stepId: null, name: 'grep' })]
			})
		);
		expect(html.split('reason-link').length - 1).toBe(1);
		expect(html).toContain('>grep<');
	});
});

describe('NodeDetailPanel source — row/call click wiring and copy + clipboard (task #230)', () => {
	const panel = componentSource('../lib/components/NodeDetailPanel.svelte');

	test('the step row onclick scrolls to the first attributed call via focusStep', () => {
		expect(panel).toContain('onclick={() => focusStep(step.id)}');
		expect(panel).toContain('async function focusStep(stepId: string)');
		expect(panel).toContain('const first = stepCalls(stepId)[0]');
	});

	test('each call button stops propagation and jumps to its own call id', () => {
		expect(panel).toContain('onclick={(event) => focusCall(event, call.id)}');
		expect(panel).toContain('async function focusCall(event: MouseEvent, id: string)');
		expect(panel).toContain('event.stopPropagation()');
	});

	test('the copy button carries an aria-label and renders an inline SVG icon', () => {
		expect(panel).toContain('class="ui-icon-btn copy"');
		expect(panel).toMatch(/aria-label=\{.*?Copy .*? call/);
		// Default state: clipboard icon; copied state: check icon (shared Icon set).
		expect(panel).toContain('<Icon name="copy"');
		expect(panel).toContain('<Icon name="check"');
	});

	test('copyCall writes via clipboard API, sets copiedCallId, and resets after 1.5s', () => {
		expect(panel).toContain('navigator.clipboard.writeText(formatToolCallText(call))');
		expect(panel).toContain('copiedCallId = call.id');
		expect(panel).toContain('setTimeout(() => {'),
		expect(panel).toContain('copiedCallId = null');
		expect(panel).toContain('copiedTimer = null');
		expect(panel).toContain('1500');
		// Graceful failure: on catch, copiedCallId is cleared.
		expect(panel).toMatch(/catch[\s\S]*?copiedCallId = null/);
	});

	test('formatToolCallText is imported from $lib/model/node (pure helper)', () => {
		expect(panel).toContain("import {");
		expect(panel).toContain('formatToolCallText');
		expect(panel).toContain("from '$lib/model/node'");
	});
});

// --- Task #241/#243: Gantt delegation connector SSR --------------------------

describe('Gantt SSR — delegation connector contract (task #241/#243/#255)', () => {
	const T0 = 1_700_000_000_000;

	test('a single-child edge renders a cubic Bézier into the child tube cap with a title', () => {
		const root = makeNode({ sessionId: 'root', startedAt: T0, endedAt: T0 + 10_000 });
		const child = makeNode({
			sessionId: 'child',
			parentSessionId: 'root',
			depth: 1,
			startedAt: T0 + 3_000,
			endedAt: T0 + 8_000
		});
		const html = renderGantt(
			makeModel({ nodes: [root, child], edges: [makeEdge({ id: 'e1', parentNodeId: 'root', childNodeId: 'child', startedAt: T0 + 2_000 })] })
		);
		// Smoothed connector: a cubic <path> from the spawn tick to the child cap.
		const edgePaths = [...html.matchAll(/<path[^>]*d="M [^"]+ C [^"]+"/g)];
		expect(edgePaths.length).toBeGreaterThanOrEqual(1);
		// Title is present.
		expect(html).toMatch(/<title[^>]*>/);
	});

	test('a parent with >= 2 children renders one cubic connector per child (N parallel curves)', () => {
		const root = makeNode({ sessionId: 'root', startedAt: T0, endedAt: T0 + 10_000 });
		const childA = makeNode({
			sessionId: 'childA',
			parentSessionId: 'root',
			depth: 1,
			startedAt: T0 + 2_000,
			endedAt: T0 + 7_000
		});
		const childB = makeNode({
			sessionId: 'childB',
			parentSessionId: 'root',
			depth: 1,
			startedAt: T0 + 4_000,
			endedAt: T0 + 9_000
		});
		const html = renderGantt(
			makeModel({
				nodes: [root, childA, childB],
				edges: [
					makeEdge({ id: 'e1', parentNodeId: 'root', childNodeId: 'childA', startedAt: T0 + 1_000 }),
					makeEdge({ id: 'e2', parentNodeId: 'root', childNodeId: 'childB', startedAt: T0 + 3_000 })
				]
			})
		);
		// No trunk line.
		expect(html).not.toContain('edge-trunk');
		// One cubic connector path per child (N parallel curves).
		const edgePaths = [...html.matchAll(/<path[^>]*d="M [^"]+ C [^"]+"/g)];
		expect(edgePaths.length).toBeGreaterThanOrEqual(2);
		// No arrowhead polygons on edges.
		const polygonMatches = [...html.matchAll(/<polygon[^>]*>/g)];
		// Any polygons present must be no-child diamond markers, not edge arrowheads.
		// With two children and both having parents, there should be zero polygons.
		expect(polygonMatches.length).toBe(0);
		// Titles present for each edge.
		expect(html).toContain('root → childA');
		expect(html).toContain('root → childB');
	});

	test('a no-child edge renders a diamond marker and is excluded from any trunk', () => {
		const root = makeNode({ sessionId: 'root', startedAt: T0, endedAt: T0 + 10_000 });
		const html = renderGantt(
			makeModel({
				nodes: [root],
				edges: [makeEdge({ id: 'e_fail', parentNodeId: 'root', childNodeId: null, startedAt: T0 + 2_000, status: 'error', error: 'spawn failed' })]
			})
		);
		// Diamond marker: 4-point polygon centered on the parent row.
		expect(html).toMatch(/<polygon points="[^"]+"/);
		// No trunk or branch lines (single no-child edge → marker only).
		expect(html).not.toContain('edge-trunk');
		// Title present.
		expect(html).toMatch(/<title[^>]*>/);
	});

	test('a running edge keeps the dash pattern', () => {
		const root = makeNode({ sessionId: 'root', startedAt: T0, endedAt: T0 + 10_000 });
		const child = makeNode({
			sessionId: 'child',
			parentSessionId: 'root',
			depth: 1,
			startedAt: T0 + 3_000,
			endedAt: null,
			running: true
		});
		const html = renderGantt(
			makeModel({
				nodes: [root, child],
				edges: [makeEdge({ id: 'e_run', parentNodeId: 'root', childNodeId: 'child', startedAt: T0 + 2_000, running: true })]
			})
		);
		// Dash pattern on the edge (Svelte may emit single or double quotes).
		expect(html).toMatch(/stroke-dasharray\s*=\s*["']4 3["']/);
	});

	test('edges render a thin gray stroke regardless of selection (task #255)', () => {
		const root = makeNode({ sessionId: 'root', startedAt: T0, endedAt: T0 + 10_000 });
		const child = makeNode({
			sessionId: 'child',
			parentSessionId: 'root',
			depth: 1,
			startedAt: T0 + 3_000,
			endedAt: T0 + 8_000
		});
		const html = renderGantt(
			makeModel({
				nodes: [root, child],
				edges: [makeEdge({ id: 'e1', parentNodeId: 'root', childNodeId: 'child', startedAt: T0 + 2_000 })]
			}),
			null
		);
		// Neutral gray inline stroke, 1px, no --border-selected recolor on selection.
		expect(html).toContain('stroke:var(--icon-base)');
		expect(html).toContain('stroke-width="1"');
	});
});
