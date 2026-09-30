/**
 * M3a API/session-page suite (task #188, ADR §6.1 / §7.2 / §7.3).
 *
 * This file intentionally has NO `.test` suffix: `health.test.ts` installs a
 * process-wide `mock.module('$lib/server/db', ...)` that bun cannot undo, so any
 * suite that exercises the real DB module must run in an isolated child
 * `bun test` process. The wrapper `api.test.ts` spawns it and asserts `0 fail`
 * (pattern from `data-layer.suite.ts` / the synaptomind repo).
 *
 * A throwaway fixture (210 filler roots + a rich `root1` subtree with two turns)
 * lives under the OS temp dir; the live opencode DB is never opened or written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { isHttpError } from '@sveltejs/kit';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	addAssistantMessage,
	addProject,
	addSessionV2,
	addUserMessage,
	applyV2Schema,
	subagentItem,
	T
} from '../../../lib/server/test-fixtures/opencode-v2';

const MODEL = { id: 'gpt-5', providerID: 'openai' };

/**
 * V2 changes three identities the assertions below depend on:
 *   - a `Step` is the assistant message itself, so step ids are message ids
 *     (`a1`, `a1b`, `a2`, `ca1`) — there is no `step-finish` row to name;
 *   - a `ToolCall`/`Edge` has no row id, so it is `messageId#contentIndex`
 *     (`a1#0`, `a1#1`, `ca1#0`);
 *   - turns come from `seq` order, not `data.parentID`, so `u1` owns `a1`+`a1b`.
 */
function buildFixture(path: string): void {
	const db = new Database(path);
	applyV2Schema(db);
	addProject(db, { name: 'M3a' });

	const addSession = (s: {
		id: string;
		parentId?: string | null;
		dir: string;
		title: string;
		agent?: string | null;
		created: number;
		updated: number;
		archived?: number | null;
		cost?: number;
		input?: number;
		output?: number;
		reasoning?: number;
		cacheRead?: number;
		cacheWrite?: number;
		model?: { id: string; providerID: string } | null;
	}) =>
		addSessionV2(db, {
			id: s.id,
			parentId: s.parentId ?? null,
			dir: s.dir,
			title: s.title,
			agent: s.agent ?? null,
			created: s.created,
			updated: s.updated,
			archived: s.archived ?? null,
			cost: s.cost ?? 0,
			tokens: {
				input: s.input ?? 0,
				output: s.output ?? 0,
				reasoning: s.reasoning ?? 0,
				cacheRead: s.cacheRead ?? 0,
				cacheWrite: s.cacheWrite ?? 0
			},
			model: s.model === undefined ? MODEL : s.model
		});

	// --- 210 filler roots (exercises the 1..200 clamp + default 50) -------
	for (let i = 0; i < 210; i++) {
		addSession({
			id: `f${String(i).padStart(3, '0')}`,
			dir: '/repo/fill',
			title: `Filler ${i}`,
			created: T + i,
			updated: T + i + 1
		});
	}

	// --- rich subtree for the detail/turn contracts -----------------------
	addSession({ id: 'root1', dir: '/repo/a', title: 'Root one', agent: 'build', created: T + 1000, updated: T + 5000, cost: 2, input: 310, output: 125, reasoning: 40, cacheRead: 20, cacheWrite: 10, model: MODEL });
	addSession({ id: 'child1', parentId: 'root1', dir: '/repo/a', title: 'Child one', agent: 'developer', created: T + 1500, updated: T + 4500, cost: 0.5, input: 50, output: 20, reasoning: 10, model: MODEL });
	addSession({ id: 'child2', parentId: 'root1', dir: '/repo/a', title: 'Child two', agent: null, created: T + 1600, updated: T + 1700, archived: T + 1700 });
	addSession({ id: 'grandchild1', parentId: 'child1', dir: '/repo/a', title: 'Grandchild', agent: 'tester', created: T + 2000, updated: T + 2500, cost: 0.1, input: 5, output: 3, reasoning: 1, model: MODEL });
	addSession({ id: 'root2', dir: '/repo/b', title: 'Root two', agent: null, created: T + 3000, updated: T + 3100 });

	// root1: three turns (u1 with two assistants, u2 with one, u3 with zero).
	// The delegation `subagent` items live in a1, so `buildTurnModel` has a
	// non-trivial GanttModel to assemble without any step parts.
	addUserMessage(db, { id: 'u1', sessionId: 'root1', seq: 1, created: T + 1100, text: 'do the thing' });
	addAssistantMessage(db, {
		id: 'a1', sessionId: 'root1', seq: 2, created: T + 1200, completed: T + 1500,
		agent: 'build', model: MODEL,
		cost: 2, tokens: { input: 300, output: 120, reasoning: 40, cacheRead: 20, cacheWrite: 10 },
		finish: 'tool-calls',
		content: [
			subagentItem({ id: 'c1', childSessionId: 'child1', agent: 'developer', description: 'build', status: 'completed', text: 'result', created: T + 1400, ran: T + 1400, completed: T + 2500 }),
			subagentItem({ id: 'c3', childSessionId: null, agent: 'broken', status: 'error', error: { type: 'error', message: 'spawn failed' }, created: T + 2600, ran: T + 2600, completed: T + 2700 })
		]
	});
	addAssistantMessage(db, {
		id: 'a1b', sessionId: 'root1', seq: 3, created: T + 1300, completed: T + 1400,
		agent: 'build', model: MODEL,
		cost: 0, tokens: { input: 10, output: 5, reasoning: 0 },
		finish: 'stop',
		content: []
	});
	addUserMessage(db, { id: 'u2', sessionId: 'root1', seq: 4, created: T + 4000, text: 'second' });
	addAssistantMessage(db, {
		id: 'a2', sessionId: 'root1', seq: 5, created: T + 4100, completed: T + 4200,
		agent: 'build', model: MODEL,
		cost: 0, tokens: { input: 20, output: 10, reasoning: 5 },
		finish: 'stop',
		content: []
	});
	// u3 has no assistant reply — exercises the LEFT JOIN / count = 0 path.
	addUserMessage(db, { id: 'u3', sessionId: 'root1', seq: 6, created: T + 5000, text: 'third' });

	// child1: its own turn, plus the delegation down to grandchild1.
	addUserMessage(db, { id: 'cu1', sessionId: 'child1', seq: 1, created: T + 1600, text: 'child prompt' });
	addAssistantMessage(db, {
		id: 'ca1', sessionId: 'child1', seq: 2, created: T + 1700, completed: T + 4500,
		agent: 'developer', model: MODEL,
		cost: 0.5, tokens: { input: 50, output: 20, reasoning: 10 },
		finish: 'tool-calls',
		content: [
			subagentItem({ id: 'c2', childSessionId: 'grandchild1', agent: 'tester', description: 'tests', status: 'completed', text: 'ok', created: T + 2000, ran: T + 2000, completed: T + 2500 })
		]
	});

	db.close();
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-m3a-api-'));
const DB_PATH = join(tempDir, 'fixture.db');
buildFixture(DB_PATH);
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

/** Absolute + cache-busted specifier so Bun resolves relative to this file. */
function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const listRoute = (await import(spec('./+server.ts'))) as {
	GET: (event: { url: URL }) => Response;
};
const detailRoute = (await import(spec('./[id]/+server.ts'))) as {
	GET: (event: { params: { id: string } }) => Response;
};
const turnsRoute = (await import(spec('./[id]/turns/+server.ts'))) as {
	GET: (event: { params: { id: string } }) => Response;
};
const turnRoute = (await import(spec('./[id]/turns/[turnId]/+server.ts'))) as {
	GET: (event: { params: { id: string; turnId: string } }) => Response;
};
const nodeRoute = (await import(spec('./[id]/nodes/[nodeId]/+server.ts'))) as {
	GET: (event: { params: { id: string; nodeId: string }; url: URL }) => Response;
};
const { buildNodeDetail } = (await import(spec('../../../lib/server/services/nodes'))) as {
	buildNodeDetail: (rootSessionId: string, nodeId: string, turnId?: string) => {
		node: Record<string, unknown>;
		steps: Array<Record<string, unknown>>;
		toolCalls: Array<Record<string, unknown>>;
		markers: unknown[];
		actions?: unknown[];
	};
};
const { buildTurnModel } = (await import(spec('../../../lib/server/services/turn'))) as {
	buildTurnModel: (rootSessionId: string, triggerMessageId: string) => {
		turnId: string;
		rootSessionId: string;
		nodes: Array<Record<string, unknown>>;
		steps: Array<Record<string, unknown>>;
		toolCalls: Array<Record<string, unknown>>;
		markers: unknown[];
		actions?: unknown[];
	} | null;
};
const { selectNodeDetail } = (await import(spec('../../../lib/model/node'))) as {
	selectNodeDetail: (model: Record<string, unknown>, nodeId: string) => {
		node: Record<string, unknown>;
		steps: Array<Record<string, unknown>>;
		toolCalls: Array<Record<string, unknown>>;
		markers: unknown[];
		actions?: unknown[];
	} | null;
};
const detailPage = (await import(spec('../../sessions/[id]/+page.server.ts'))) as {
	load: (event: { params: { id: string }; url?: URL }) => Promise<unknown>;
};
const { listRecentRootSessions, countRecentRootSessions } = (await import(
	spec('../../../lib/server/queries/sessions.ts')
)) as {
	listRecentRootSessions: (
		limit: number,
		directory?: string,
		offset?: number,
		query?: string
	) => Array<{ id: string }>;
	countRecentRootSessions: (directory?: string, query?: string) => number;
};
const { getDb, resolveDbPath: resolveFixtureDbPath } = (await import(
	spec('../../../lib/server/db.ts')
)) as {
	getDb: () => { query: (sql: string) => { get: () => unknown }; exec: (sql: string) => void };
	resolveDbPath: () => string;
};
const { listTurns, getSessionDetail } = (await import(
	spec('../../../lib/server/services/sessions.ts')
)) as {
	listTurns: (rootSessionId: string) => Array<{ turnId: string; index: number; startedAt: number; assistantCount: number }> | null;
	getSessionDetail: (rootSessionId: string) => { turns: Array<{ turnId: string; index: number; startedAt: number; assistantCount: number }> } | null;
};

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

async function body(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

function listResponse(query = ''): Response {
	return listRoute.GET({ url: new URL(`http://localhost/api/sessions${query}`) });
}

describe('GET /api/sessions — limit handling and ordering', () => {
	test('defaults to 50 and returns SessionSummary rows newest-first', async () => {
		const response = listResponse();
		expect(response.status).toBe(200);
		const rows = (await response.json()) as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(50);
		expect(Object.keys(rows[0]).sort()).toEqual([
			'agent',
			'childCount',
			'createdAt',
			'directory',
			'id',
			'title',
			'updatedAt',
			'usage'
		]);
		const created = rows.map((row) => row.createdAt as number);
		expect(created).toEqual([...created].sort((a, b) => b - a));
	});

	test('clamps an explicit limit into 1..200', async () => {
		expect(((await listResponse('?limit=1').json()) as unknown[]).length).toBe(1);
		expect(((await listResponse('?limit=0').json()) as unknown[]).length).toBe(1);
		expect(((await listResponse('?limit=-5').json()) as unknown[]).length).toBe(1);
		expect(((await listResponse('?limit=999').json()) as unknown[]).length).toBe(200);
	});

	test('falls back to the default on a non-numeric limit (never NaN/empty)', async () => {
		expect(((await listResponse('?limit=abc').json()) as unknown[]).length).toBe(50);
		expect(((await listResponse('?limit=').json()) as unknown[]).length).toBe(50);
		// A fractional limit truncates rather than throwing.
		expect(((await listResponse('?limit=3.9').json()) as unknown[]).length).toBe(3);
	});

	test('directory filters in the query layer, and the route passes it through', async () => {
		const a = listRecentRootSessions(50, '/repo/a');
		expect(a.map((session) => session.id)).toEqual(['root1']);
		const b = listRecentRootSessions(50, '/repo/b');
		expect(b.map((session) => session.id)).toEqual(['root2']);

		const viaRoute = (await listResponse('?directory=/repo/b').json()) as Array<{ id: string }>;
		expect(viaRoute.map((session) => session.id)).toEqual(['root2']);
		// Empty string is treated as "no filter".
		expect(((await listResponse('?directory=').json()) as unknown[]).length).toBe(50);
	});
});

describe('GET /api/sessions — offset paging (M4b)', () => {
	test('defaults to offset 0 (unchanged first page)', async () => {
		const rows = (await listResponse().json()) as Array<{ id: string }>;
		expect(rows).toHaveLength(50);
		expect(rows[0].id).toBe('root2');
		// root2 (T+3000) > root1 (T+1000) > filler f209..f000
		expect(rows[1].id).toBe('root1');
		expect(rows[2].id).toBe('f209');
	});

	test('offset=1 skips exactly the newest row', async () => {
		const rows = (await listResponse('?offset=1').json()) as Array<{ id: string }>;
		expect(rows).toHaveLength(50);
		expect(rows[0].id).toBe('root1');
	});

	test('clamps a negative / garbage / empty offset to 0', async () => {
		for (const query of ['?offset=-5', '?offset=abc', '?offset=']) {
			const rows = (await listResponse(query).json()) as Array<{ id: string }>;
			expect(rows).toHaveLength(50);
			expect(rows[0].id).toBe('root2');
		}
	});

	test('truncates a fractional offset', async () => {
		const rows = (await listResponse('?offset=2.9').json()) as Array<{ id: string }>;
		expect(rows).toHaveLength(50);
		expect(rows[0].id).toBe('f209');
	});

	test('an offset beyond the end returns an empty array (never throws)', async () => {
		const total = countRecentRootSessions();
		expect(total).toBe(212);
		for (const offset of [total, total + 1, 9999]) {
			const response = listResponse(`?offset=${offset}`);
			expect(response.status).toBe(200);
			expect((await response.json()) as unknown[]).toEqual([]);
		}
		// The last row is reachable and singular.
		const lastPage = (await listResponse(`?offset=${total - 1}`).json()) as Array<{ id: string }>;
		expect(lastPage.map((row) => row.id)).toEqual(['f000']);
	});

	test('keeps the directory filter alongside offset', async () => {
		const a0 = (await listResponse('?directory=/repo/a&offset=0').json()) as Array<{ id: string }>;
		expect(a0.map((row) => row.id)).toEqual(['root1']);
		const a1 = (await listResponse('?directory=/repo/a&offset=1').json()) as unknown[];
		expect(a1).toEqual([]);

		const b0 = (await listResponse('?directory=/repo/b&offset=0').json()) as Array<{ id: string }>;
		expect(b0.map((row) => row.id)).toEqual(['root2']);

		// The filler scope is preserved too.
		const fill = (await listResponse('?directory=/repo/fill&offset=0').json()) as unknown[];
		expect(fill).toHaveLength(50);
	});

	test('still clamps limit to 1..200 when offset is present', async () => {
		expect(((await listResponse('?limit=999&offset=1').json()) as unknown[]).length).toBe(200);
		expect(((await listResponse('?limit=0&offset=1').json()) as unknown[]).length).toBe(1);
		expect(((await listResponse('?limit=abc&offset=1').json()) as unknown[]).length).toBe(50);
	});

	test('the response stays a backwards-compatible SessionSummary[]', async () => {
		const rows = (await listResponse('?offset=1').json()) as Array<Record<string, unknown>>;
		expect(Object.keys(rows[0]).sort()).toEqual([
			'agent',
			'childCount',
			'createdAt',
			'directory',
			'id',
			'title',
			'updatedAt',
			'usage'
		]);
		const created = rows.map((row) => row.createdAt as number);
		expect(created).toEqual([...created].sort((a, b) => b - a));
	});

	test('countRecentRootSessions respects the directory scope', () => {
		expect(countRecentRootSessions()).toBe(212);
		expect(countRecentRootSessions('/repo/a')).toBe(1);
		expect(countRecentRootSessions('/repo/b')).toBe(1);
		expect(countRecentRootSessions('/repo/fill')).toBe(210);
		expect(countRecentRootSessions('/repo/missing')).toBe(0);
		// Empty string is "no filter", matching the list function.
		expect(countRecentRootSessions('')).toBe(212);
	});
});

describe('GET /api/sessions — q search filter (U1)', () => {
	const ids = async (query: string): Promise<string[]> =>
		((await listResponse(query).json()) as Array<{ id: string }>).map((row) => row.id);

	test('matches title, id and directory case-insensitively (roots only)', async () => {
		// Title: "Root one" / "Root two" (filler titles are "Filler N").
		expect(await ids('?q=root one')).toEqual(['root1']);
		expect((await ids('?q=ROOT')).sort()).toEqual(['root1', 'root2']);
		// id
		expect(await ids('?q=root2')).toEqual(['root2']);
		// directory
		expect((await ids('?q=repo%2Fa')).sort()).toEqual(['root1']);
		expect(await ids('?q=REPO%2FB')).toEqual(['root2']);
		// The matching child sessions (child1/child2/grandchild1) are never roots.
		expect(await ids('?q=child')).toEqual([]);
	});

	test('an empty or whitespace-only q behaves as unfiltered', async () => {
		for (const query of ['?q=', '?q=%20%20', '?q=%09', '?q=+++']) {
			const rows = (await listResponse(query).json()) as unknown[];
			expect(rows).toHaveLength(50);
			expect((rows[0] as { id: string }).id).toBe('root2');
		}
		// The query layer treats blank terms the same way.
		expect(listRecentRootSessions(50, undefined, 0, '')).toHaveLength(50);
		expect(listRecentRootSessions(50, undefined, 0, '   ')).toHaveLength(50);
		expect(countRecentRootSessions(undefined, '')).toBe(212);
		expect(countRecentRootSessions(undefined, '   ')).toBe(212);
	});

	test('a term with no match returns an empty array (status 200, never throws)', async () => {
		const response = listResponse('?q=zzz-no-such-session');
		expect(response.status).toBe(200);
		expect((await response.json()) as unknown[]).toEqual([]);
		expect(countRecentRootSessions(undefined, 'zzz-no-such-session')).toBe(0);
	});

	test('combines with limit, offset and directory', async () => {
		// Search + limit.
		expect(((await listResponse('?q=filler&limit=3').json()) as unknown[]).length).toBe(3);
		// Search + directory + offset: newest-first fillers are f209, f208, ...
		expect(await ids('?q=filler&directory=%2Frepo%2Ffill&offset=1&limit=2')).toEqual([
			'f208',
			'f207'
		]);
		// Search + directory narrows the same way as the unfiltered list.
		expect(await ids('?q=root&directory=%2Frepo%2Fb')).toEqual(['root2']);
		expect(await ids('?q=root&directory=%2Frepo%2Fa')).toEqual(['root1']);
		// A non-matching directory wins (empty intersection).
		expect(await ids('?q=root&directory=%2Frepo%2Ffill')).toEqual([]);
		// The query layer agrees with the route.
		expect(countRecentRootSessions('/repo/fill', 'filler')).toBe(210);
		expect(countRecentRootSessions(undefined, 'root')).toBe(2);
		expect(countRecentRootSessions('/repo/b', 'root')).toBe(1);
	});

	test('keeps the SessionSummary shape and newest-first order', async () => {
		const rows = (await listResponse('?q=filler').json()) as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(50);
		expect(Object.keys(rows[0]).sort()).toEqual([
			'agent',
			'childCount',
			'createdAt',
			'directory',
			'id',
			'title',
			'updatedAt',
			'usage'
		]);
		const created = rows.map((row) => row.createdAt as number);
		expect(created).toEqual([...created].sort((a, b) => b - a));
		// Every returned row really matches the term.
		expect(
			rows.every((row) => String(row.title).toLowerCase().includes('filler'))
		).toBe(true);
	});
});

describe('GET /api/sessions/[id] — detail + 404', () => {
	test('returns summary, children, edges and a 1-based root turn list', async () => {
		const response = detailRoute.GET({ params: { id: 'root1' } });
		expect(response.status).toBe(200);
		const detail = (await body(response)) as {
			session: Record<string, unknown>;
			children: Array<Record<string, unknown>>;
			edges: Array<Record<string, unknown>>;
			turns: Array<Record<string, unknown>>;
		};

		expect(detail.session).toMatchObject({
			id: 'root1',
			title: 'Root one',
			agent: 'build',
			directory: '/repo/a',
			childCount: 2
		});

		expect(detail.children.map((child) => [child.id, child.depth])).toEqual([
			['child1', 1],
			['child2', 1],
			['grandchild1', 2]
		]);

		expect(detail.edges.map((edge) => edge.id).sort()).toEqual(['a1#0', 'a1#1', 'ca1#0']);
		expect(detail.edges.find((edge) => edge.id === 'a1#0')).toMatchObject({
			parentNodeId: 'root1',
			childNodeId: 'child1',
			subagentType: 'developer',
			status: 'completed'
		});
		expect(detail.edges.find((edge) => edge.id === 'a1#1')).toMatchObject({
			childNodeId: null,
			status: 'error'
		});

		expect(detail.turns).toEqual([
			{ turnId: 'u1', index: 1, startedAt: T + 1100, assistantCount: 2 },
			{ turnId: 'u2', index: 2, startedAt: T + 4000, assistantCount: 1 },
			{ turnId: 'u3', index: 3, startedAt: T + 5000, assistantCount: 0 }
		]);
	});

	test('an unknown id is a 404 JSON error', async () => {
		const response = detailRoute.GET({ params: { id: 'does-not-exist' } });
		expect(response.status).toBe(404);
		const payload = await body(response);
		expect(typeof payload.error).toBe('string');
		expect(payload.error).toContain('does-not-exist');
	});
});

	describe('GET /api/sessions/[id]/turns — TurnSummary[] + 404 (task #388)', () => {
		test('returns HTTP 200 with the expected TurnSummary[] for a fixture root session', async () => {
			const response = turnsRoute.GET({ params: { id: 'root1' } });
			expect(response.status).toBe(200);
			const turns = (await response.json()) as Array<Record<string, unknown>>;
			expect(turns).toHaveLength(3);
			expect(turns.map((t) => t.turnId)).toEqual(['u1', 'u2', 'u3']);
			expect(turns.map((t) => t.index)).toEqual([1, 2, 3]);
			expect(turns.map((t) => t.startedAt)).toEqual([T + 1100, T + 4000, T + 5000]);
			expect(turns.map((t) => t.assistantCount)).toEqual([2, 1, 0]);
			expect(Object.keys(turns[0]).sort()).toEqual(['assistantCount', 'index', 'startedAt', 'turnId']);
		});

		test('returns an empty TurnSummary[] for a root with no user triggers', async () => {
			// root2 has no messages at all in the fixture.
			const response = turnsRoute.GET({ params: { id: 'root2' } });
			expect(response.status).toBe(200);
			const turns = (await response.json()) as unknown[];
			expect(turns).toEqual([]);
		});

		test('unknown session returns 404 JSON error', async () => {
			const response = turnsRoute.GET({ params: { id: 'does-not-exist' } });
			expect(response.status).toBe(404);
			const payload = await body(response);
			expect(typeof payload.error).toBe('string');
			expect(payload.error).toContain('does-not-exist');
		});
	});

	describe('listTurns — service contract (task #388)', () => {
		test('user-trigger counts and assistantCount match the fixture', () => {
			const turns = listTurns('root1');
			expect(turns).not.toBeNull();
			expect(turns).toHaveLength(3);
			expect(turns![0]).toEqual({ turnId: 'u1', index: 1, startedAt: T + 1100, assistantCount: 2 });
			expect(turns![1]).toEqual({ turnId: 'u2', index: 2, startedAt: T + 4000, assistantCount: 1 });
			expect(turns![2]).toEqual({ turnId: 'u3', index: 3, startedAt: T + 5000, assistantCount: 0 });
		});

		test('a session with no messages returns an empty array, not null', () => {
			const turns = listTurns('root2');
			expect(turns).toEqual([]);
		});

		test('unknown session returns null', () => {
			expect(listTurns('does-not-exist')).toBeNull();
		});
	});

	describe('regression — endpoint equals getSessionDetail.turns (task #388)', () => {
		test('the /turns endpoint and getSessionDetail return identical turn lists for the fixture root', async () => {
			const turnsResponse = await turnsRoute.GET({ params: { id: 'root1' } }).json();
			const detail = getSessionDetail('root1');
			expect(detail).not.toBeNull();
			expect(turnsResponse).toEqual(detail!.turns);
		});
	});

	describe('GET /api/sessions/[id]/turns/[turnId] — GanttModel + 404', () => {
	test('returns the GanttModel for a valid root + trigger', async () => {
		const response = turnRoute.GET({ params: { id: 'root1', turnId: 'u1' } });
		expect(response.status).toBe(200);
		const model = (await body(response)) as Record<string, unknown>;
		expect(model.turnId).toBe('root1_u1');
		expect(model.rootSessionId).toBe('root1');
		expect(Array.isArray(model.nodes)).toBe(true);
		expect((model.nodes as Array<{ sessionId: string }>).map((node) => node.sessionId)).toContain('root1');
	});

	test('unknown root and unknown trigger are 404 JSON errors', async () => {
		for (const params of [
			{ id: 'does-not-exist', turnId: 'u1' },
			{ id: 'root1', turnId: 'does-not-exist' },
			{ id: 'root1', turnId: 'a1' }
		]) {
			const response = turnRoute.GET({ params });
			expect(response.status).toBe(404);
			const payload = await body(response);
			expect(typeof payload.error).toBe('string');
		}
	});
});

describe('GET /api/sessions/[id]/nodes/[nodeId] — NodeDetail + 404', () => {
	function nodeResponse(id: string, nodeId: string, query = ''): Response {
		return nodeRoute.GET({
			params: { id, nodeId },
			url: new URL(`http://localhost/api/sessions/${id}/nodes/${nodeId}${query}`)
		});
	}

	test('returns the NodeDetail shape for a valid node with ?turn= (own slice only)', async () => {
		const response = nodeResponse('root1', 'child1', '?turn=u1');
		expect(response.status).toBe(200);
		const detail = (await body(response)) as {
			node: Record<string, unknown>;
			steps: Array<Record<string, unknown>>;
			toolCalls: Array<Record<string, unknown>>;
			markers: unknown[];
		};
		expect(Object.keys(detail).sort()).toEqual([
			'actions',
			'markers',
			'node',
			'steps',
			'toolCalls'
		]);
		expect(detail.node).toMatchObject({
			sessionId: 'child1',
			parentSessionId: 'root1',
			kind: 'subagent',
			depth: 1,
			status: 'completed'
		});
		// child1 owns step ca1 and its own delegation; no root step/tool leaks in.
		expect(detail.steps.map((step) => step.id)).toEqual(['ca1']);
		expect(detail.toolCalls.map((call) => call.id)).toEqual(['ca1#0']);
		expect(detail.markers).toEqual([]);
	});

	test('returns the root node slice for ?turn= (root steps/tools of that turn only)', async () => {
		const response = nodeResponse('root1', 'root1', '?turn=u1');
		expect(response.status).toBe(200);
		const detail = (await body(response)) as {
			node: Record<string, unknown>;
			steps: Array<Record<string, unknown>>;
			toolCalls: Array<Record<string, unknown>>;
			markers: unknown[];
		};
		expect(detail.node).toMatchObject({ sessionId: 'root1', kind: 'orchestrator', depth: 0 });
		// Turn u1 owns assistant messages a1 and a1b — one Step each (D-1).
		expect(detail.steps.map((step) => step.id).sort()).toEqual(['a1', 'a1b']);
		expect(detail.toolCalls.map((call) => call.id).sort()).toEqual(['a1#0', 'a1#1']);
		expect(detail.markers).toEqual([]);
	});

	test('locates the owning turn when ?turn= is omitted (root user-trigger scan)', async () => {
		const response = nodeResponse('root1', 'grandchild1');
		expect(response.status).toBe(200);
		const detail = (await body(response)) as {
			node: { sessionId: string; depth: number };
			steps: Array<{ id: string; nodeId: string }>;
			toolCalls: unknown[];
		};
		expect(detail.node).toMatchObject({ sessionId: 'grandchild1', depth: 2 });
		// This fixture seeds grandchild1 with no messages/parts: the fallback
		// scan must still return the node (empty slice), not a 404.
		expect(detail.steps).toEqual([]);
		expect(detail.steps.every((step) => step.nodeId === 'grandchild1')).toBe(true);
		expect(detail.toolCalls).toEqual([]);
	});

	test('unknown node is a 404 JSON error (with and without ?turn=)', async () => {
		for (const query of ['?turn=u1', '']) {
			const response = nodeResponse('root1', 'does-not-exist', query);
			expect(response.status).toBe(404);
			const payload = await body(response);
			expect(typeof payload.error).toBe('string');
			expect(payload.error).toContain('does-not-exist');
		}
	});

	test('a subtree session with no turn is a 404 when ?turn= is omitted', async () => {
		// child2 is under root1 but has no spawn edge, so no turn owns it; the
		// fallback scan must reject it instead of returning a wrong turn.
		const response = nodeResponse('root1', 'child2');
		expect(response.status).toBe(404);
		expect((await body(response)).error).toContain('child2');
	});

	test('unknown root is a 404 JSON error (with and without ?turn=)', async () => {
		for (const query of ['?turn=u1', '']) {
			const response = nodeResponse('does-not-exist', 'root1', query);
			expect(response.status).toBe(404);
			expect((await body(response)).error).toContain('does-not-exist');
		}
	});

	test('unknown / non-user / empty turn is a 404 JSON error', async () => {
		for (const turn of ['does-not-exist', 'a1', '']) {
			const response = nodeResponse('root1', 'root1', `?turn=${turn}`);
			expect(response.status).toBe(404);
			const payload = await body(response);
			expect(typeof payload.error).toBe('string');
			expect(payload.error).toContain('root1');
		}
	});

	test('the node route performs no writes', () => {
		const db = getDb();
		const count = (table: string): number =>
			(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
		const snapshot = {
			session: count('session_v2'),
			message: count('session_message')
		};

		// Exercise every branch that reaches the DB.
		for (const [id, nodeId, query] of [
			['root1', 'child1', '?turn=u1'],
			['root1', 'grandchild1', ''],
			['root1', 'does-not-exist', '?turn=u1'],
			['does-not-exist', 'root1', '']
		] as const) {
			nodeResponse(id, nodeId, query);
		}

		expect({
			session: count('session_v2'),
			message: count('session_message')
		}).toEqual(snapshot);
		// The connection itself stays query_only.
		expect(db.query('PRAGMA query_only').get()).toEqual({ query_only: 1 });
	});

	/**
	 * Progressive per-node detail — fetch-on-select, cache parity, no-leak, and
	 * error path (task #392).
	 *
	 * The Gantt component's in-browser detailCache is not testable without a DOM
	 * runtime; instead we cover the two pure data paths that feed it:
	 *
	 *   - The server `buildNodeDetail` used by the route above.
	 *   - The client `selectNodeDetail` used by the already-loaded `GanttModel`.
	 *
	 * A parity assertion verifies both return the same shape for root / child /
	 * grandchild, and the no-leak assertions confirm a node's detail only carries
	 * that node's own steps/toolCalls/markers/actions.
	 */

	// Strip time-sensitive, non-semantic fields so the comparison is stable
	// across the two builders (buildNodeDetail vs buildTurnModel + selectNodeDetail).
	function normalizeForParity(
		detail: Record<string, unknown>
	): Record<string, unknown> {
		const node = detail.node as Record<string, unknown>;
		const strippedNode = Object.fromEntries(
			Object.entries(node).filter(([k]) => !['flags', 'trackerRefs'].includes(k))
		);
		return {
			node: strippedNode,
			steps: (detail.steps as Record<string, unknown>[]).map((s) =>
				Object.fromEntries(Object.entries(s).filter(([k]) => !['flags'].includes(k)))
			),
			toolCalls: (detail.toolCalls as Record<string, unknown>[]).map((t) =>
				Object.fromEntries(Object.entries(t).filter(([k]) => !['flags'].includes(k)))
			),
			markers: detail.markers,
			actions: detail.actions
		};
	}

	test('root detail: correct DTO shape, all steps/tools scoped to root', async () => {
		const response = nodeResponse('root1', 'root1', '?turn=u1');
		expect(response.status).toBe(200);
		const detail = await body(response);
		expect(Object.keys(detail).sort()).toEqual([
			'actions',
			'markers',
			'node',
			'steps',
			'toolCalls'
		]);
		const d = detail as Record<string, unknown>;
		// Root owns its own steps and tools; nothing from child/grandchild leaks in.
		const steps = d.steps as Array<Record<string, unknown>>;
		const tools = d.toolCalls as Array<Record<string, unknown>>;
		expect(steps.every((s) => s.nodeId === 'root1')).toBe(true);
		expect(tools.every((t) => t.nodeId === 'root1')).toBe(true);
		// Step ids for turn u1 on root: one per assistant message (a1, a1b).
		expect(steps.map((s) => s.id).sort()).toEqual(['a1', 'a1b']);
	});

	test('child detail: correct DTO shape, all steps/tools scoped to child', async () => {
		const response = nodeResponse('root1', 'child1', '?turn=u1');
		expect(response.status).toBe(200);
		const detail = await body(response);
		const d = detail as Record<string, unknown>;
		expect((d.node as Record<string, unknown>).sessionId).toBe('child1');
		const steps = d.steps as Array<Record<string, unknown>>;
		const tools = d.toolCalls as Array<Record<string, unknown>>;
		expect(steps.every((s) => s.nodeId === 'child1')).toBe(true);
		expect(tools.every((t) => t.nodeId === 'child1')).toBe(true);
		expect(steps.map((s) => s.id)).toEqual(['ca1']);
		// child1's own tool: the delegation to grandchild1.
		expect(tools.map((t) => t.id)).toEqual(['ca1#0']);
	});

	test('grandchild detail: correct DTO shape, all steps/tools scoped to grandchild', async () => {
		const response = nodeResponse('root1', 'grandchild1', '?turn=u1');
		expect(response.status).toBe(200);
		const detail = await body(response);
		const d = detail as Record<string, unknown>;
		expect((d.node as Record<string, unknown>).sessionId).toBe('grandchild1');
		expect((d.steps as Array<Record<string, unknown>>)
			.every((s) => s.nodeId === 'grandchild1')).toBe(true);
		expect((d.toolCalls as Array<Record<string, unknown>>)
			.every((t) => t.nodeId === 'grandchild1')).toBe(true);
	});

	test('switching nodes never shows a previous node\'s steps/tools/markers', async () => {
		const rootDetail = (await body(nodeResponse('root1', 'root1', '?turn=u1'))) as Record<string, unknown>;
		const childDetail = (await body(nodeResponse('root1', 'child1', '?turn=u1'))) as Record<string, unknown>;
		const gcDetail = (await body(nodeResponse('root1', 'grandchild1', '?turn=u1'))) as Record<string, unknown>;

		// Each node's detail contains only its own data.
		for (const [label, d] of [['root', rootDetail], ['child', childDetail], ['gc', gcDetail]] as const) {
			const sid = (d.node as Record<string, unknown>).sessionId as string;
			const steps = d.steps as Array<Record<string, unknown>>;
			const tools = d.toolCalls as Array<Record<string, unknown>>;
			const markers = d.markers as Array<Record<string, unknown>>;
			expect(steps.every((s) => s.nodeId === sid), `${label} steps leak`).toBe(true);
			expect(tools.every((t) => t.nodeId === sid), `${label} tools leak`).toBe(true);
			expect(markers.every((m) => m.nodeId === sid), `${label} markers leak`).toBe(true);
		}

		// Cross-node containment: root steps are NOT in child detail and vice versa.
		const rootStepIds = new Set((rootDetail.steps as Array<Record<string, unknown>>).map((s) => s.id));
		const childStepIds = new Set((childDetail.steps as Array<Record<string, unknown>>).map((s) => s.id));
		expect(rootStepIds.has('ca1')).toBe(false); // root must not have child's step
		expect(childStepIds.has('a1')).toBe(false); // child must not have root's step
	});

	test('server parity: buildNodeDetail matches selectNodeDetail(buildTurnModel) for root', async () => {
		const direct = buildNodeDetail('root1', 'root1', 'u1');
		expect(direct).not.toBeNull();
		const fullModel = buildTurnModel('root1', 'u1');
		expect(fullModel).not.toBeNull();
		const selected = selectNodeDetail(fullModel as Record<string, unknown>, 'root1');
		expect(selected).not.toBeNull();
		expect(normalizeForParity(direct!)).toEqual(normalizeForParity(selected!));
	});

	test('server parity: buildNodeDetail matches selectNodeDetail(buildTurnModel) for child', async () => {
		const direct = buildNodeDetail('root1', 'child1', 'u1');
		expect(direct).not.toBeNull();
		const fullModel = buildTurnModel('root1', 'u1');
		expect(fullModel).not.toBeNull();
		const selected = selectNodeDetail(fullModel as Record<string, unknown>, 'child1');
		expect(selected).not.toBeNull();
		expect(normalizeForParity(direct!)).toEqual(normalizeForParity(selected!));
	});

	test('server parity: buildNodeDetail matches selectNodeDetail(buildTurnModel) for grandchild', async () => {
		const direct = buildNodeDetail('root1', 'grandchild1', 'u1');
		expect(direct).not.toBeNull();
		const fullModel = buildTurnModel('root1', 'u1');
		expect(fullModel).not.toBeNull();
		const selected = selectNodeDetail(fullModel as Record<string, unknown>, 'grandchild1');
		expect(selected).not.toBeNull();
		expect(normalizeForParity(direct!)).toEqual(normalizeForParity(selected!));
	});

	test('404 parity: both builders return null for an unknown node', async () => {
		expect(buildNodeDetail('root1', 'does-not-exist', 'u1')).toBeNull();
		const fullModel = buildTurnModel('root1', 'u1');
		expect(selectNodeDetail(fullModel as Record<string, unknown>, 'does-not-exist')).toBeNull();
	});

	test('404 parity: both builders return null for an unknown root', async () => {
		expect(buildNodeDetail('does-not-exist', 'root1', 'u1')).toBeNull();
		expect(buildTurnModel('does-not-exist', 'u1')).toBeNull();
	});

	test('404 parity: unknown turn gives null from both paths', async () => {
		expect(buildNodeDetail('root1', 'root1', 'nope')).toBeNull();
		expect(buildTurnModel('root1', 'nope')).toBeNull();
	});
});

describe('session page — load() data', () => {
	// `/` has no `+page.server.ts` anymore (task #215): it is a tree-only
	// placeholder, so the former recent-root-sessions list/offset coverage was
	// removed with it. The `/api/sessions` list contract is still fully covered
	// above, and the session detail page loader is covered below.

	test('/sessions/[id] loads the session detail and 404s when unknown', async () => {
		const data = (await detailPage.load({ params: { id: 'root1' } })) as {
			session: { id: string };
			turns: unknown[];
			gantt: unknown;
		};
		expect(data.session.id).toBe('root1');
		expect(data.turns).toHaveLength(3);
		// No `?turn=` query -> the server never builds a Gantt model.
		expect(data.gantt).toBeNull();

		try {
			await detailPage.load({ params: { id: 'does-not-exist' } });
			throw new Error('expected load() to throw');
		} catch (error) {
			expect(isHttpError(error)).toBe(true);
			expect((error as { status: number }).status).toBe(404);
		}
	});

	test('/sessions/[id]?turn= loads the GanttModel for a valid trigger', async () => {
		const data = (await detailPage.load({
			params: { id: 'root1' },
			url: new URL('http://localhost/sessions/root1?turn=u1')
		})) as {
			session: { id: string };
			// The Gantt is streamed: the loader returns the header synchronously
			// and defers the model behind this promise (task #385).
			gantt: Promise<{
				turnId: string;
				rootSessionId: string;
				t0: number;
				nodes: Array<{ sessionId: string }>;
				edges: Array<{ id: string }>;
			}> | null;
		};
		expect(data.session.id).toBe('root1');
		expect(data.gantt).not.toBeNull();
		const gantt = await data.gantt;
		expect(gantt?.turnId).toBe('root1_u1');
		expect(gantt?.rootSessionId).toBe('root1');
		expect(gantt?.t0).toBe(T + 1100);
		expect(gantt?.nodes.map((node) => node.sessionId)).toContain('root1');
		expect(gantt?.edges.map((edge) => edge.id).sort()).toEqual(['a1#0', 'a1#1', 'ca1#0']);
	});

	test('/sessions/[id]?turn= 404s for an unknown / non-user / empty trigger', async () => {
		for (const turn of ['does-not-exist', 'a1', '']) {
			try {
				await detailPage.load({
					params: { id: 'root1' },
					url: new URL(`http://localhost/sessions/root1?turn=${turn}`)
				});
				throw new Error(`expected load() to throw for turn "${turn}"`);
			} catch (error) {
				expect(isHttpError(error)).toBe(true);
				expect((error as { status: number }).status).toBe(404);
			}
		}
	});

	test('/sessions/[id]?turn= 404s when the session itself is unknown', () => {
		try {
			detailPage.load({
				params: { id: 'does-not-exist' },
				url: new URL('http://localhost/sessions/does-not-exist?turn=u1')
			});
			throw new Error('expected load() to throw');
		} catch (error) {
			expect(isHttpError(error)).toBe(true);
			expect((error as { status: number }).status).toBe(404);
		}
	});
});

describe('read-only guard', () => {
	test('the fixture connection is query_only and cannot write', () => {
		expect(resolveFixtureDbPath()).toBe(DB_PATH);
		expect(existsSync(DB_PATH)).toBe(true);
		const db = getDb();
		expect(db.query('PRAGMA query_only').get()).toEqual({ query_only: 1 });
		expect(() => db.exec("INSERT INTO session_v2 (id, project_id, slug, directory, version) VALUES ('nope', 'p', 'nope', '/', '2.0.20')")).toThrow(/readonly/i);
	});

	test('the list route and session page load perform no writes', async () => {
		const db = getDb();
		const count = (table: string): number =>
			(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
		const snapshot = {
			session: count('session_v2'),
			message: count('session_message')
		};

		// Exercise every offset branch of the list route.
		for (const query of [
			'',
			'?offset=1',
			'?offset=9999',
			'?offset=-5',
			'?directory=/repo/a&offset=1',
			'?limit=999&offset=3',
			'?q=root',
			'?q=filler&directory=/repo/fill&offset=1',
			'?q=%25'
		]) {
			listResponse(query);
		}
		// The session detail page loader (with and without ?turn=) also reads only.
		for (const query of ['', '?turn=u1', '?turn=does-not-exist']) {
			try {
				const result = (await detailPage.load({
					params: { id: 'root1' },
					url: new URL(`http://localhost/sessions/root1${query}`)
				})) as { gantt: Promise<unknown> | null };
				// Resolve the streamed model so its reads happen inside this probe.
				await result.gantt;
			} catch {
				// A 404 for the unknown turn is still a read attempt, not a write.
			}
		}

		expect({
			session: count('session_v2'),
			message: count('session_message')
		}).toEqual(snapshot);
		expect(db.query('PRAGMA query_only').get()).toEqual({ query_only: 1 });
	});
});
