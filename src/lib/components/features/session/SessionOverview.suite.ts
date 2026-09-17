/**
 * Unit tests for SessionOverview (task #535/#536).
 *
 * SSR-rendered via vite.ssrLoadModule — no DOM runtime. Pins the turn list,
 * Older/Newer pager, child depth indentation, subtree totals and leaf empty
 * state so the overview can never silently regress to a dead end.
 */
import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { createServer, type ViteDevServer } from 'vite';

type RenderFn = (
	component: unknown,
	options: { props: Record<string, unknown> }
) => { body: string };

let vite: ViteDevServer;
let render: RenderFn;
let SessionOverview: unknown;

beforeAll(async () => {
	vite = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'error'
	});
	render = ((await vite.ssrLoadModule('svelte/server')) as { render: RenderFn }).render;
	SessionOverview = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/session/SessionOverview.svelte'
		)) as { default: unknown }
	).default;
}, 60_000);

afterAll(async () => {
	await vite?.close();
});

// --- Fixture helpers ----------------------------------------------------------

const T = 1_700_000_000_000;

function rootSession() {
	return {
		id: 'root1',
		title: 'Root one',
		agent: 'build',
		directory: '/repo/a',
		createdAt: T,
		updatedAt: T + 900,
		usage: { input: 310, output: 125, reasoning: 40, cacheRead: 20, cacheWrite: 10, total: 505, cost: 2 },
		childCount: 1
	};
}

function childSession(id: string, depth: number) {
	return {
		id,
		parentId: 'root1',
		title: 'Child one',
		agent: 'developer',
		directory: '/repo/a',
		depth,
		createdAt: T + 500,
		updatedAt: T + 800,
		archivedAt: null,
		usage: { input: 50, output: 20, reasoning: 10, cacheRead: 0, cacheWrite: 0, total: 80, cost: 0.5 }
	};
}

function turn(id: string, index: number) {
	return {
		turnId: id,
		index,
		startedAt: T + index * 1_000,
		assistantCount: 1
	};
}

function windowFor(turns: Array<{ turnId: string; index: number }>, size = 50) {
	const total = turns.length;
	const start = 0;
	const end = Math.min(total, size);
	return {
		turns: turns.slice(start, end),
		total,
		start,
		end,
		size,
		hiddenOlder: start,
		hiddenNewer: total - end,
		hasOlder: start > 0,
		hasNewer: end < total
	};
}

function renderOverview(props: Record<string, unknown> = {}): string {
	return render(SessionOverview, { props }).body;
}

// --- Windowed turns ------------------------------------------------------------

describe('SessionOverview — windowed turns', () => {
	test('renders each turn with index, formatted time, assistant-message label and ?turn= link', () => {
		const html = renderOverview({
			session: rootSession(),
			turns: [turn('u1', 1)],
			turnWindow: windowFor([turn('u1', 1)]),
			subagents: []
		});

		expect(html).toContain('Turns (1)');
		expect(html).toContain('Turn 1');
		// Time is deterministic in UTC (SSR default).
		expect(html).toContain('2023-11-14 22:13:21');
		expect(html).toContain('1 assistant message');
		// The turn links to its Gantt via ?turn=.
		expect(html).toContain('href="/sessions/root1?turn=u1"');
	});

	test('renders multiple turns with ascending indices and distinct ?turn= links', () => {
		const turns = [turn('u1', 1), turn('u2', 2), turn('u3', 3)];
		const html = renderOverview({
			session: rootSession(),
			turns,
			turnWindow: windowFor(turns),
			subagents: []
		});

		expect(html).toContain('Turns (3)');
		expect(html).toContain('href="/sessions/root1?turn=u1"');
		expect(html).toContain('href="/sessions/root1?turn=u2"');
		expect(html).toContain('href="/sessions/root1?turn=u3"');
		// Three turn rows, each with a distinct index.
		expect(html.split('Turn 1').length - 1).toBe(1);
		expect(html.split('Turn 2').length - 1).toBe(1);
		expect(html.split('Turn 3').length - 1).toBe(1);
	});

	test('multi-message turns show the plural label', () => {
		const html = renderOverview({
			session: rootSession(),
			turns: [
				{ turnId: 'u1', index: 1, startedAt: T, assistantCount: 3 }
			],
			turnWindow: windowFor([{ turnId: 'u1', index: 1 }]),
			subagents: []
		});

		expect(html).toContain('3 assistant messages');
	});
});

// --- Pager (Older/Newer) ------------------------------------------------------

describe('SessionOverview — Older/Newer pager', () => {
	test('shows enabled older link when hasOlder is true, with hiddenOlder count and ?turnStart= target', () => {
		// Build 120 turns and slice a mid-window (start=50, end=100).
		const allTurns = Array.from({ length: 120 }, (_, i) => ({ turnId: `u${i}`, index: i + 1 }));
		const midTurns = allTurns.slice(50, 100);
		const midWindow = {
			turns: midTurns,
			total: 120,
			start: 50,
			end: 100,
			size: 50,
			hiddenOlder: 50,
			hiddenNewer: 20,
			hasOlder: true,
			hasNewer: true
		};
		const html = renderOverview({
			session: rootSession(),
			turns: midTurns,
			turnWindow: midWindow,
			subagents: []
		});

		// Older link is an <a> with the right ?turnStart= target.
		expect(html).toContain('Load older turns (50)');
		// turnPageTargets: older = start - size = 50 - 50 = 0.
		expect(html).toContain('href="/sessions/root1?turnStart=0"');

		// Newer link is an <a> with ?turnStart= end.
		expect(html).toContain('Newer turns (20) →');
		expect(html).toContain('href="/sessions/root1?turnStart=100"');
	});

	test('disables older when hasOlder is false (first page)', () => {
		const html = renderOverview({
			session: rootSession(),
			turns: [turn('u1', 1)],
			turnWindow: windowFor([turn('u1', 1)]),
			subagents: []
		});

		// No <a> with Load older turns; the disabled span is present.
		const olderLink = html.match(/<a[^>]*>Load older turns/);
		expect(olderLink).toBeNull();
		expect(html).toContain('pager-control--off');
		expect(html).toContain('Load older turns');
	});

	test('disables newer when hasNewer is false (last page)', () => {
		const html = renderOverview({
			session: rootSession(),
			turns: [turn('u1', 1)],
			turnWindow: windowFor([turn('u1', 1)]),
			subagents: []
		});

		const newerLink = html.match(/<a[^>]*>Newer turns/);
		expect(newerLink).toBeNull();
		expect(html).toContain('Newer turns →');
	});

	test('pager-range shows the correct 1-based slice', () => {
		const allTurns = Array.from({ length: 120 }, (_, i) => ({ turnId: `u${i}`, index: i + 1 }));
		const midTurns = allTurns.slice(50, 100);
		const midWindow = {
			turns: midTurns,
			total: 120,
			start: 50,
			end: 100,
			size: 50,
			hiddenOlder: 50,
			hiddenNewer: 20,
			hasOlder: true,
			hasNewer: true
		};
		const html = renderOverview({
			session: rootSession(),
			turns: midTurns,
			turnWindow: midWindow,
			subagents: []
		});

		// pager-range shows the correct 1-based slice.
		expect(html).toContain('Showing 51–100 of 120');
	});
});

// --- Children / depth ---------------------------------------------------------

describe('SessionOverview — child rows and depth', () => {
	test('each child row carries its depth as an inline style variable', () => {
		const depth1 = childSession('child1', 1);
		const depth2 = childSession('grandchild1', 2);
		const html = renderOverview({
			session: rootSession(),
			turns: [],
			turnWindow: windowFor([]),
			subagents: [depth1, depth2]
		});

		expect(html).toContain('Subagents (2)');
		// Svelte SSR emits style="--depth: N;" on the child-row.
		expect(html).toMatch(/--depth:\s*1/);
		expect(html).toMatch(/--depth:\s*2/);
		// Each child links to its own session page.
		expect(html).toContain('href="/sessions/child1"');
		expect(html).toContain('href="/sessions/grandchild1"');
	});

	test('a single direct child renders its agent label and duration', () => {
		const child = childSession('c1', 1);
		const html = renderOverview({
			session: rootSession(),
			turns: [],
			turnWindow: windowFor([]),
			subagents: [child]
		});

		expect(html).toContain('Subagents (1)');
		// displayAgent('developer') -> 'developer'.
		expect(html).toContain('developer');
		// Duration = 300ms -> floor(0.3) = 0s.
		expect(html).toContain('0s');
	});
});

// --- Subtree totals ------------------------------------------------------------

describe('SessionOverview — subtree totals', () => {
	test('totals equal root usage plus all children (addUsage)', () => {
		const child = childSession('c1', 1);
		// Root: total=505, cost=2. Child: total=80, cost=0.5. Sum: total=585, cost=2.5.
		const html = renderOverview({
			session: rootSession(),
			turns: [turn('u1', 1)],
			turnWindow: windowFor([turn('u1', 1)]),
			subagents: [child]
		});

		expect(html).toContain('Subtree totals');
		// formatNumber(585) -> "585".
		expect(html).toContain('585');
		// formatCost(2.5) -> "$2.5000".
		expect(html).toContain('$2.5000');
		// Session count = root + children.
		expect(html).toContain('Sessions');
		expect(html.match(/Sessions[\s\S]*?2/)?.[0]).toBeDefined();
	});

	test('a session with no children shows only root usage', () => {
		const html = renderOverview({
			session: rootSession(),
			turns: [turn('u1', 1)],
			turnWindow: windowFor([turn('u1', 1)]),
			subagents: []
		});

		expect(html).toContain('Subtree totals');
		expect(html).toContain('505');
		expect(html).toContain('$2.0000');
		expect(html).toContain('Sessions');
	});

	test('multiple children accumulate into the subtree total', () => {
		const c1 = { ...childSession('c1', 1), usage: { input: 10, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 20, cost: 0.1 } };
		const c2 = { ...childSession('c2', 1), usage: { input: 5, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10, cost: 0.05 } };
		const html = renderOverview({
			session: rootSession(),
			turns: [],
			turnWindow: windowFor([]),
			subagents: [c1, c2]
		});

		// 505 + 20 + 10 = 535 tokens; 2 + 0.1 + 0.05 = 2.15 cost.
		expect(html).toContain('535');
		expect(html).toContain('$2.1500');
		expect(html).toContain('Sessions');
		expect(html.match(/Sessions[\s\S]*?3/)?.[0]).toBeDefined();
	});
});

// --- Leaf / empty state -------------------------------------------------------

describe('SessionOverview — leaf session empty state', () => {
	test('a session with no turns and no children renders the laconic empty line', () => {
		const html = renderOverview({
			session: { ...rootSession(), childCount: 0 },
			turns: [],
			turnWindow: windowFor([]),
			subagents: []
		});

		expect(html).toContain('No turns or subagents.');
		expect(html).not.toContain('Turns (');
		expect(html).not.toContain('Subagents (');
		expect(html).not.toContain('Subtree totals');
	});

	test('turns present but no children: only Turns section renders, not empty state', () => {
		const html = renderOverview({
			session: rootSession(),
			turns: [turn('u1', 1)],
			turnWindow: windowFor([turn('u1', 1)]),
			subagents: []
		});

		expect(html).not.toContain('No turns or subagents.');
		expect(html).toContain('Turns (1)');
	});

	test('children present but no turns: only Subagents section renders, not empty state', () => {
		const html = renderOverview({
			session: { ...rootSession(), childCount: 1 },
			turns: [],
			turnWindow: windowFor([]),
			subagents: [childSession('c1', 1)]
		});

		expect(html).not.toContain('No turns or subagents.');
		expect(html).toContain('Subagents (1)');
	});
});

// --- Section structure --------------------------------------------------------

describe('SessionOverview — section structure and aria', () => {
	test('root section carries aria-label="Session overview"', () => {
		const html = renderOverview({
			session: rootSession(),
			turns: [],
			turnWindow: windowFor([]),
			subagents: []
		});

		expect(html).toContain('aria-label="Session overview"');
	});

	test('turns section is a ui-card with h2 section-title', () => {
		const html = renderOverview({
			session: rootSession(),
			turns: [turn('u1', 1)],
			turnWindow: windowFor([turn('u1', 1)]),
			subagents: []
		});

		expect(html).toContain('class="ui-card');
		expect(html).toContain('section-title');
		expect(html).toContain('Turns (1)');
	});

	test('subagents section is a ui-card with h2 section-title', () => {
		const html = renderOverview({
			session: rootSession(),
			turns: [],
			turnWindow: windowFor([]),
			subagents: [childSession('c1', 1)]
		});

		expect(html).toContain('Subagents (1)');
	});

	test('subtree totals section is always rendered when not leaf', () => {
		const html = renderOverview({
			session: rootSession(),
			turns: [turn('u1', 1)],
			turnWindow: windowFor([turn('u1', 1)]),
			subagents: [childSession('c1', 1)]
		});

		expect(html).toContain('Subtree totals');
		expect(html).toContain('class="ui-card');
	});
});
