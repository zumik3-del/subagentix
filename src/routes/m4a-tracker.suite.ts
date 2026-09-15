/**
 * M4a ziptask-chip render suite (task #199, feature #198; modal #263).
 *
 * Isolated child process (see `pages.test.ts` for why). There is no DOM test
 * runtime in this repo (no jsdom / happy-dom / Playwright; the POC dependency
 * budget is SvelteKit only), so this suite renders the client `Gantt` component
 * through its server renderer:
 *
 *   vite.ssrLoadModule(...) -> svelte/server render(Component, { props })
 *
 * The chips are now modal triggers, not external links: this covers the
 * turn-header and node-row buttons (`type="button"`, `ui-chip--link`), the
 * `inferred` title/aria-label, the `>=2` unified collapse into an `N tasks`
 * button + slide-down list, the no-link / not-configured states and HTML
 * escaping of a hostile ref. The modal itself is client-only (it opens on
 * click), so its wiring is asserted at the source level; the detail layout is
 * covered by the M3c suite and the proxy contract by the tracker API test.
 *
 * No DB and no `$lib/server` import: the live opencode DB is never touched.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import type { Edge, GanttModel, Node, ToolCall, Usage } from '$lib/model/types';

type RenderFn = (
	component: unknown,
	options: { props: Record<string, unknown> }
) => { body: string };

let vite: ViteDevServer;
let render: RenderFn;
let Gantt: unknown;

beforeAll(async () => {
	vite = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'error'
	});
	const server = (await vite.ssrLoadModule('svelte/server')) as { render: unknown };
	render = server.render as RenderFn;
	Gantt = (
		(await vite.ssrLoadModule('/src/lib/components/features/gantt/Gantt.svelte')) as {
			default: unknown;
		}
	).default;
}, 60_000);

afterAll(async () => {
	await vite?.close();
});

// --- Fixtures ---------------------------------------------------------------

const usage = (): Usage => ({
	input: 0,
	output: 0,
	reasoning: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	cost: 0
});

function makeNode(overrides: Partial<Node> & { sessionId: string }): Node {
	return {
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
		usage: usage(),
		stepCount: 0,
		toolCallCount: 0,
		errorCount: 0,
		compactionCount: 0,
		openStep: false,
		...overrides
	};
}

function makeTool(overrides: Partial<ToolCall> & { id: string; nodeId: string }): ToolCall {
	return {
		stepId: null,
		callId: 'c',
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

function makeEdge(overrides: Partial<Edge> & { id: string; parentNodeId: string }): Edge {
	return {
		childNodeId: null,
		subagentType: null,
		status: 'completed',
		error: null,
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_001_000,
		running: false,
		flags: [],
		resultBytes: 0,
		description: null,
		trackerRefs: [],
		...overrides
	};
}

function makeModel(overrides: Partial<GanttModel> = {}): GanttModel {
	return {
		turnId: 'root1_u1',
		rootSessionId: 'root1',
		agent: 'build',
		t0: 1_700_000_000_000,
		t1: 1_700_000_010_000,
		nodes: [makeNode({ sessionId: 'root1' })],
		edges: [],
		steps: [],
		toolCalls: [],
		markers: [],
		...overrides
	};
}

function renderGantt(model: GanttModel, ziptaskBaseUrl: string | null = null): string {
	return render(Gantt, { props: { model, ziptaskBaseUrl } }).body;
}

function countOf(html: string, needle: string): number {
	return html.split(needle).length - 1;
}

const ganttSource = readFileSync(new URL('../lib/components/features/gantt/Gantt.svelte', import.meta.url), 'utf8');
const chipListSource = readFileSync(
	new URL('../lib/components/composites/TrackerChipList.svelte', import.meta.url),
	'utf8'
);
// Task #279: the per-row label markup (which forwards `onOpen` to the chip
// list) moved to GanttLabelRow.svelte.
const labelRowSource = readFileSync(
	new URL('../lib/components/features/gantt/GanttLabelRow.svelte', import.meta.url),
	'utf8'
);
const panelSource = readFileSync(
	new URL('../lib/components/features/node-detail/NodeDetailPanel.svelte', import.meta.url),
	'utf8'
);
const summaryStripSource = readFileSync(
	new URL('../lib/components/features/node-detail/NodeSummaryStrip.svelte', import.meta.url),
	'utf8'
);
const modalSource = readFileSync(new URL('../lib/components/features/tracker/TaskModal.svelte', import.meta.url), 'utf8');

// --- Chip buttons and labels -------------------------------------------------

describe('Gantt SSR — inferred task chips open the detail modal', () => {
	test('node-row chips are buttons with an inferred title/aria-label', () => {
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: ['185'] })] }),
			'https://zt.example'
		);
		expect(html).toContain('<button type="button" class="ui-chip ui-chip--link');
		expect(html).toContain('title="Task #185 (inferred tracker link)"');
		expect(html).toContain('aria-label="Task #185 (inferred tracker link)"');
		// The owning node row only: the turn-level header block is gone.
		expect(countOf(html, 'ui-chip--link')).toBe(1);
		// No external navigation is emitted any more.
		expect(html).not.toContain('href=');
		expect(html).not.toContain('/task/');
	});

	test('renders an "N tasks" toggle when refs come from tool calls / edges (>=2)', () => {
		const html = renderGantt(
			makeModel({
				nodes: [
					makeNode({ sessionId: 'root1' }),
					makeNode({
						sessionId: 'child1',
						parentSessionId: 'root1',
						depth: 1,
						kind: 'subagent',
						agent: 'developer'
					})
				],
				toolCalls: [makeTool({ id: 't1', nodeId: 'root1', trackerRefs: ['77'] })],
				edges: [makeEdge({ id: 'e1', parentNodeId: 'root1', trackerRefs: ['88'] })]
			}),
			'https://zt.example'
		);
		// root1 falls back to its tool-call + edge refs (2) → toggle button.
		expect(html).toContain('2 tasks');
		expect(html).toContain('ui-chip--toggle');
		// Individual #N chips are NOT rendered at SSR (they live inside the dropdown).
		expect(html).not.toContain('>#77</button>');
		expect(html).not.toContain('>#88</button>');
	});

	test('a hostile id is escaped in the label and never becomes a URL', () => {
		const ref = 'a b/c?d#e';
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: [ref] })] }),
			'https://zt.example'
		);
		// The visible text keeps the ref verbatim (Svelte escapes only markup).
		expect(html).toContain('>#a b/c?d#e</button>');
		// No URL is built from the ref, encoded or otherwise.
		expect(html).not.toContain('/task/');
		expect(html).not.toContain('href=');
	});
});

// --- Feature toggle ---------------------------------------------------------

describe('Gantt SSR — ziptask feature toggle', () => {
	test('disabling the integration hides every active tracker chip', () => {
		const html = render(Gantt, {
			props: {
				model: makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: ['185'] })] }),
				ziptaskBaseUrl: 'https://zt.example',
				ziptaskEnabled: false
			}
		}).body;
		expect(html).not.toContain('ui-chip--link');
		expect(html).not.toContain('Tracker links');
	});
});

// --- Unified >=2 collapse ---------------------------------------------------

describe('Gantt SSR — >=2 distinct refs show "N tasks" toggle + list', () => {
	test('1 ref stays a single #N chip, no toggle', () => {
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: ['1'] })] }),
			'https://zt.example'
		);
		expect(countOf(html, 'ui-chip--link')).toBe(1);
		expect(html).not.toContain('ui-chip--toggle');
		expect(html).not.toContain('1 tasks');
	});

	test('2 refs show a "2 tasks" toggle; no individual chips at SSR', () => {
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: ['1', '2'] })] }),
			'https://zt.example'
		);
		expect(html).toContain('2 tasks');
		expect(countOf(html, 'ui-chip--toggle')).toBe(1);
		// The dropdown is client-side ($state), so SSR emits only the toggle.
		expect(countOf(html, 'ui-chip--link')).toBe(0);
		expect(html).not.toContain('>#1</button>');
		expect(html).not.toContain('>#2</button>');
	});

	test('a large set labels the toggle with the total; no chips at SSR', () => {
		const refs = ['1', '2', '3', '4', '5', '6', '7'];
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: refs })] }),
			'https://zt.example'
		);
		expect(html).toContain('7 tasks');
		expect(countOf(html, 'ui-chip--toggle')).toBe(1);
		expect(countOf(html, 'ui-chip--link')).toBe(0);
	});
});

// --- List interaction (SSR-visible markup) -----------------------------------

describe('Gantt SSR — list interaction markup', () => {
	test('the toggle carries aria-expanded="false" at SSR', () => {
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: ['1', '2'] })] }),
			'https://zt.example'
		);
		expect(html).toContain('aria-expanded="false"');
	});

	test('the toggle carries data-refs-toggle for client selectors', () => {
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: ['1', '2'] })] }),
			'https://zt.example'
		);
		expect(html).toContain('data-refs-toggle');
	});

	test('the refs-menu wrapper class is absent at SSR (dropdown is client-only)', () => {
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: ['1', '2'] })] }),
			'https://zt.example'
		);
		// SSR does not run $state, so the dropdown is not emitted.
		expect(html).not.toContain('class="refs-menu');
	});

	test('node-refs has pointer-events:none in CSS; ref buttons re-enable it', () => {
		// Source-level check: the CSS rule that lets clicks pass through to the
		// full-bleed selection layer is present in GanttLabelRow.
		expect(labelRowSource).toContain('.node-refs {');
		expect(labelRowSource).toContain('pointer-events: none');
		expect(labelRowSource).toContain(':global(button) {');
		expect(labelRowSource).toContain('pointer-events: auto');
	});

	test('.label-btn has a full-bleed ::after hit layer', () => {
		expect(labelRowSource).toContain('.label-btn::after {');
		expect(labelRowSource).toContain("content: ''");
		expect(labelRowSource).toContain('inset: 0');
	});
});

// --- No-link / not-configured states ----------------------------------------

describe('Gantt SSR — no-link and unconfigured-base states', () => {
	test('a configured base with no inferred ref renders no tracker UI', () => {
		const html = renderGantt(makeModel(), 'https://zt.example');
		expect(html).not.toContain('No tracker link.');
		expect(html).not.toContain('ZIPTASK_BASE_URL is not configured.');
		expect(html).not.toContain('ui-chip--link');
	});

	test('an unset base renders node chips as inert text without a trigger', () => {
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: ['185'] })] }),
			null
		);
		expect(html).toContain('#185');
		expect(html).not.toContain('ZIPTASK_BASE_URL is not configured.');
		expect(html).not.toContain('ui-chip--link');
		expect(html).not.toContain('href=');
		expect(html).not.toContain('/task/185');
	});

	test('an unset base and no refs renders no tracker UI', () => {
		const html = renderGantt(makeModel(), null);
		expect(html).not.toContain('ZIPTASK_BASE_URL is not configured.');
		expect(html).not.toContain('No tracker link.');
	});
});

// --- Escaping ---------------------------------------------------------------

describe('Gantt SSR — escaping and raw-HTML hygiene', () => {
	test('escapes a hostile ref in the title/aria-label and in the visible text', () => {
		const ref = '<img src=x onerror=alert(1)>';
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: [ref] })] }),
			'https://zt.example'
		);
		// Svelte escapes the leading `<`; the payload can never open a tag.
		expect(html).toContain('&lt;img src=x onerror=alert(1)');
		expect(html).not.toContain('<img src=x');
		expect(html).toContain('(inferred tracker link)');
		expect(html).not.toContain('href=');
	});

	test('the chip is wired to open the modal, not navigate', () => {
		expect(ganttSource).toContain("import TaskModal from '$lib/components/features/tracker/TaskModal.svelte';");
		expect(ganttSource).toContain('let activeTaskId = $state<string | null>(null);');
		// Task #278: the chip markup moved to TrackerChipList, which calls the
		// `onOpen` callback the Gantt root still owns.
		expect(chipListSource).toContain('onclick={() => onOpen?.(refs[0])}');
		expect(labelRowSource).toContain('onOpen={refBase !== null ? onOpenTask : undefined}');
		expect(ganttSource).toContain('onOpenTask={openTask}');
		expect(ganttSource).toContain('<TaskModal id={activeTaskId} onClose={closeTask} />');
		// The panel forwards the callback to the summary strip, which delegates
		// to the same owner instead of linking out.
		expect(panelSource).toContain('{onOpenTask}');
		// The summary strip forwards the callback to TrackerChipList via the
		// `onOpen` prop; the list itself invokes `onOpenTask?.(ref)` per item.
		expect(summaryStripSource).toContain('onOpen={onOpenTask}');
	});

	test('the modal fetches subagentix\'s own proxy and uses no raw HTML', () => {
		expect(modalSource).toContain('`/api/tracker/task/${encodeURIComponent(id)}`');
		expect(/@html/.test(modalSource)).toBe(false);
		const imports = modalSource
			.split('\n')
			.filter((line) => /^\s*import\b/.test(line))
			.join('\n');
		expect(imports).not.toMatch(/\$lib\/server|bun:sqlite|opencode\.db|OPENCODE_DB/);
	});

	test('Gantt.svelte uses no {@html} and imports no server-only module', () => {
		expect(/@html/.test(ganttSource)).toBe(false);
		expect(/bun:sqlite|opencode\.db|OPENCODE_DB/.test(ganttSource)).toBe(false);
		// The M4a helpers are the client-side ones, not the server service.
		expect(ganttSource).not.toContain('$lib/server');
		expect(ganttSource).toContain("from '$lib/model/tracker'");
	});
});

// --- Task #251: node-column regression (session id removed, plain #N links) ---

describe('Gantt SSR — #251 node-column contract', () => {
	test('visible chip text is #N without a "Task " prefix in element text', () => {
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: ['42'] })] }),
			'https://zt.example'
		);
		// The rendered text content of the chip button must be just `#42`.
		expect(html).toContain('>#42</button>');
		expect(html).not.toMatch(/<button[^>]*>\s*Task #42\s*<\/button>/);
	});

	test('title and aria-label still carry the full "Task #N (inferred tracker link)" label', () => {
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: ['99'] })] }),
			'https://zt.example'
		);
		expect(html).toContain('title="Task #99 (inferred tracker link)"');
		expect(html).toContain('aria-label="Task #99 (inferred tracker link)"');
	});

	test('two refs render as a toggle, not individual chips, at SSR', () => {
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: ['10', '20'] })] }),
			'https://zt.example'
		);
		// >=2 refs: single toggle, no individual #N chips in SSR output.
		expect(html).toContain('2 tasks');
		expect(html).toContain('ui-chip--toggle');
		expect(html).not.toContain('>#10</button>');
		expect(html).not.toContain('>#20</button>');
		// Still no anchors anywhere.
		expect(html).not.toMatch(/<a[^>]*ui-chip--link/);
	});

	test('the node row does not render a ses_... short id', () => {
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: ['5'] })] }),
			'https://zt.example'
		);
		// The sessionId is `root1` (no ses_ prefix), but even a ses_ id must not
		// appear in the node label row. The only place nodeShortId survives is
		// the SVG aria-label — not the row text.
		expect(html).not.toMatch(/ses_[a-z0-9]+/);
		// The raw sessionId itself must not leak as visible text in the row either.
		expect(html).not.toMatch(/>\s*root1\s*</);
	});

	test('the toggle renders as a <button>, not an <a>', () => {
		const html = renderGantt(
			makeModel({
				nodes: [makeNode({ sessionId: 'root1', trackerRefs: ['1', '2', '3', '4', '5'] })]
			}),
			'https://zt.example'
		);
		// The toggle must be a <button> element.
		expect(html).toContain('<button');
		expect(html).toMatch(/class="[^"]*ui-chip--toggle[^"]*"/);
		// It must NOT be an anchor.
		expect(html).not.toMatch(/<a[^>]*class="[^"]*ui-chip--toggle[^"]*"[^>]*>/);
	});

	test('clicking the non-tracker part of the node cell selects the node (source)', () => {
		// The full-bleed ::after on .label-btn makes the entire row clickable
		// while the tracker controls sit in a sibling with pointer-events:none
		// and re-enable events on their own buttons. Source-level proof:
		expect(labelRowSource).toContain('.label-btn::after {');
		expect(labelRowSource).toContain('inset: 0');
		expect(labelRowSource).toContain('.node-refs {');
		expect(labelRowSource).toContain('pointer-events: none');
		expect(labelRowSource).toContain(':global(button) {');
		expect(labelRowSource).toContain('pointer-events: auto');
		// The button itself owns the onSelect callback.
		expect(labelRowSource).toContain('onclick={() => onSelect(row.node.sessionId)}');
	});
});

// --- Task #367 / #368: TrackerChipList mouseleave close behavior --------------

describe('Gantt SSR — TrackerChipList mouseleave/mouseenter wiring (task #367, guard #368)', () => {
	test('the .tracker-refs wrapper carries onmouseleave={scheduleLeave}', () => {
		expect(chipListSource).toContain('class="tracker-refs"');
		expect(chipListSource).toContain('onmouseleave={scheduleLeave}');
	});

	test('the .tracker-refs wrapper carries onmouseenter={cancelLeave} to bridge the gap', () => {
		expect(chipListSource).toContain('onmouseenter={cancelLeave}');
	});

	test('scheduleLeave uses a 150ms grace timer to avoid false-closing across the trigger→panel gap', () => {
		expect(chipListSource).toContain('LEAVE_CLOSE_DELAY_MS = 150');
		expect(chipListSource).toContain('scheduleLeave');
		expect(chipListSource).toContain('setTimeout');
	});

	test('cancelLeave clears the pending close timer', () => {
		expect(chipListSource).toContain('cancelLeave');
		expect(chipListSource).toContain('clearTimeout(leaveTimer)');
	});

	test('the refs-menu is not rendered at SSR (dropdown is client-only) — no regression', () => {
		const html = renderGantt(
			makeModel({ nodes: [makeNode({ sessionId: 'root1', trackerRefs: ['1', '2'] })] }),
			'https://zt.example'
		);
		expect(html).not.toContain('class="refs-menu');
		expect(html).not.toContain('refs-menu--up');
		// The toggle and wrapper are still present.
		expect(html).toContain('ui-chip--toggle');
		expect(html).toContain('tracker-refs');
	});

	test('the mouseleave/mouseenter handlers live on the wrapper, not the toggle alone', () => {
		// The handlers must be on the <span class="tracker-refs"> so that entering
		// the panel (which sits outside the toggle's box) cancels the close timer.
		const wrapperLineIdx = chipListSource.indexOf('class="tracker-refs"');
		const mouseleaveIdx = chipListSource.indexOf('onmouseleave={scheduleLeave}');
		const mouseenterIdx = chipListSource.indexOf('onmouseenter={cancelLeave}');
		expect(wrapperLineIdx).toBeGreaterThan(-1);
		expect(mouseleaveIdx).toBeGreaterThan(-1);
		expect(mouseenterIdx).toBeGreaterThan(-1);
		// Handlers appear after the wrapper opening tag (same or subsequent lines).
		expect(mouseleaveIdx).toBeGreaterThanOrEqual(wrapperLineIdx);
		expect(mouseenterIdx).toBeGreaterThanOrEqual(wrapperLineIdx);
	});
});
