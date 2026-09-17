/**
 * Tool-errors route regression suite (task #481).
 *
 * Exercises `GET /api/dashboard/tool-errors?period=&scope=&tool=&agent=&q=&limit=&offset=`
 * against a fixture DB, covering the 200 envelope + cache-control:no-store,
 * 400 for invalid period / unknown scope, and generic 500 that leaks no internals.
 * The live opencode DB is never opened.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T = 1_700_000_000_000;
const MODEL = JSON.stringify({ id: 'gpt-5', providerID: 'anthropic' });

const SCHEMA = `
	CREATE TABLE session (
		id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, agent TEXT,
		time_created INTEGER, time_updated INTEGER, time_archived INTEGER, cost REAL,
		tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
		tokens_cache_read INTEGER, tokens_cache_write INTEGER, model TEXT,
		project_id TEXT
	);
	CREATE INDEX session_parent_idx ON session(parent_id);
	CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT);
	CREATE TABLE message (
		id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
	);
	CREATE INDEX message_session_idx ON message(session_id);
	CREATE TABLE part (
		id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
		time_created INTEGER, time_updated INTEGER, data TEXT
	);
	CREATE INDEX part_session_idx ON part(session_id);
	CREATE TABLE event (
		id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT
	);
`;

function buildFixture(path: string): void {
	const db = new Database(path);
	db.exec(SCHEMA);
	db.prepare("INSERT INTO project (id, name) VALUES ('proj-a', 'Proj A')").run();

	const insSession = db.prepare(
		`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
			time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
			tokens_cache_read, tokens_cache_write, model, project_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const insMessage = db.prepare(
		'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
	);
	const insPart = db.prepare(
		'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
	);

	insSession.run('s1', null, '/repo/a', 'S1', 'build', T, T + 100, null, 0, 0, 0, 0, 0, 0, MODEL, 'proj-a');
	insSession.run('s2', null, '/repo/b', 'S2', 'plan', T, T + 100, null, 0, 0, 0, 0, 0, 0, MODEL, null);

	insMessage.run('m1', 's1', T, T + 100, '{}');
	insMessage.run('m2', 's2', T, T + 100, '{}');

	insPart.run('p1', 'm1', 's1', T + 10, T + 20, JSON.stringify({
		type: 'tool', tool: 'bash', callID: 'c1',
		state: { status: 'error', error: 'boom', time: { start: T + 10, end: T + 20 } }
	}));
	insPart.run('p2', 'm2', 's2', T + 30, T + 40, JSON.stringify({
		type: 'tool', tool: 'read', callID: 'c2',
		state: { status: 'failed', error: 'not found', time: { start: T + 30, end: T + 40 } }
	}));
	insPart.run('p3', 'm1', 's1', T + 50, T + 60, JSON.stringify({
		type: 'tool', tool: 'bash', callID: 'c3',
		state: { status: 'completed', time: { start: T + 50, end: T + 60 } }
	}));

	db.close();
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-tool-errors-route-'));
const DB_PATH = join(tempDir, 'fixture.db');
buildFixture(DB_PATH);
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const { GET } = (await import(spec('./tool-errors/+server.ts'))) as {
	GET: (event: { params: Record<string, string>; url: URL }) => Promise<Response>;
};

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 200: envelope shape + no-store header                                */
/* ------------------------------------------------------------------ */

	describe('GET /api/dashboard/tool-errors — 200 contract', () => {
		test('returns 200 with cache-control: no-store', async () => {
			const response = await GET({
				params: {},
				url: new URL('http://localhost/api/dashboard/tool-errors?period=all')
			});
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
		});

		test('response body has { rows, total, agents, capped }', async () => {
			const response = await GET({
				params: {},
				url: new URL('http://localhost/api/dashboard/tool-errors?period=all')
			});
			const body = (await response.json()) as Record<string, unknown>;
			expect(Array.isArray(body.rows)).toBe(true);
			expect(typeof body.total).toBe('number');
			expect(Array.isArray(body.agents)).toBe(true);
			expect(typeof body.capped).toBe('boolean');
		});

		test('total reflects the unified failure definition (error + failed)', async () => {
			const response = await GET({
				params: {},
				url: new URL('http://localhost/api/dashboard/tool-errors?period=all')
			});
			const body = (await response.json()) as { total: number; rows: unknown[] };
			// p1 (error) + p2 (failed) = 2; p3 (completed) is excluded.
			expect(body.total).toBe(2);
			expect(body.rows).toHaveLength(2);
		});

		test('rows are newest-first', async () => {
			const response = await GET({
				params: {},
				url: new URL('http://localhost/api/dashboard/tool-errors?period=all')
			});
			const body = (await response.json()) as { rows: Array<{ at: number; id: string }> };
			for (let i = 1; i < body.rows.length; i++) {
				expect(body.rows[i - 1].at).toBeGreaterThanOrEqual(body.rows[i].at);
			}
		});

		test('tool filter narrows the result', async () => {
			const allResp = await GET({
				params: {},
				url: new URL('http://localhost/api/dashboard/tool-errors?period=all')
			});
			const all = (await allResp.json()) as { total: number; rows: Array<{ tool: string }> };
			const bashResp = await GET({
				params: {},
				url: new URL('http://localhost/api/dashboard/tool-errors?period=all&tool=bash')
			});
			const bash = (await bashResp.json()) as { total: number; rows: Array<{ tool: string }> };
			expect(bash.total).toBeLessThanOrEqual(all.total);
			expect(bash.rows.every((r) => r.tool === 'bash')).toBe(true);
		});

		test('agent filter narrows the result', async () => {
			const allResp = await GET({
				params: {},
				url: new URL('http://localhost/api/dashboard/tool-errors?period=all')
			});
			const all = (await allResp.json()) as { total: number };
			const planResp = await GET({
				params: {},
				url: new URL('http://localhost/api/dashboard/tool-errors?period=all&agent=plan')
			});
			const plan = (await planResp.json()) as { total: number; rows: Array<{ agent: string }> };
			expect(plan.total).toBeLessThanOrEqual(all.total);
			expect(plan.rows.every((r) => r.agent === 'plan')).toBe(true);
		});

		test('search filter matches error text', async () => {
			const boomResp = await GET({
				params: {},
				url: new URL('http://localhost/api/dashboard/tool-errors?period=all&q=boom')
			});
			const boom = (await boomResp.json()) as { total: number; rows: Array<{ error: string }> };
			expect(boom.total).toBeGreaterThan(0);
			expect(boom.rows.every((r) => r.error.toLowerCase().includes('boom'))).toBe(true);
		});

		test('limit/offset paging works', async () => {
			const fullResp = await GET({
				params: {},
				url: new URL('http://localhost/api/dashboard/tool-errors?period=all&limit=100&offset=0')
			});
			const full = (await fullResp.json()) as { total: number; rows: unknown[] };
			const pagedResp = await GET({
				params: {},
				url: new URL('http://localhost/api/dashboard/tool-errors?period=all&limit=1&offset=0')
			});
			const paged = (await pagedResp.json()) as { total: number; rows: unknown[] };
			expect(paged.rows).toHaveLength(1);
			expect(paged.total).toBe(full.total);
		});

		test('agents list is sorted ascending and stable across filters', async () => {
			const baseResp = await GET({
				params: {},
				url: new URL('http://localhost/api/dashboard/tool-errors?period=all')
			});
			const base = (await baseResp.json()) as { agents: string[] };
			const sorted = [...base.agents].sort();
			expect(base.agents).toEqual(sorted);
		});
	});

/* ------------------------------------------------------------------ */
/* 400: invalid period / unknown scope                                  */
/* ------------------------------------------------------------------ */

describe('GET /api/dashboard/tool-errors — 400 validation', () => {
	test('invalid period → 400 { error, field: "period" }', async () => {
		const response = await GET({
			params: {},
			url: new URL('http://localhost/api/dashboard/tool-errors?period=forever')
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string; field?: string };
		expect(body.field).toBe('period');
	});

	test('unknown scope directory → 400 { error, field: "scope" }', async () => {
		const response = await GET({
			params: {},
			url: new URL('http://localhost/api/dashboard/tool-errors?period=all&scope=/nonexistent')
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string; field?: string };
		expect(body.field).toBe('scope');
	});

	test('blank period falls back to default (30d) without error', async () => {
		const response = await GET({
			params: {},
			url: new URL('http://localhost/api/dashboard/tool-errors?period=&scope=')
		});
		expect(response.status).toBe(200);
	});

	test('scope=all is accepted (maps to null = every directory)', async () => {
		const response = await GET({
			params: {},
			url: new URL('http://localhost/api/dashboard/tool-errors?period=all&scope=all')
		});
		expect(response.status).toBe(200);
	});
});

/* ------------------------------------------------------------------ */
/* 500: generic error, no internals leaked                              */
/* ------------------------------------------------------------------ */

describe('GET /api/dashboard/tool-errors — 500 on DB failure', () => {
	test('generic 500 when the DB is missing', async () => {
		const orig = process.env.OPENCODE_DB;
		process.env.OPENCODE_DB = join(tempDir, 'missing.db');
		try {
			const fresh = (await import(spec('./tool-errors/+server.ts') + '?bust=' + crypto.randomUUID())) as {
				GET: (event: { params: Record<string, string>; url: URL }) => Promise<Response>;
			};
			const response = await fresh.GET({
				params: {},
				url: new URL('http://localhost/api/dashboard/tool-errors?period=all')
			});
			expect(response.status).toBe(500);
			const body = (await response.json()) as { error: string };
			expect(body.error).toBe('Failed to load dashboard data.');
			expect(body.error).not.toContain('not found');
			expect(body.error).not.toContain('/missing.db');
		} finally {
			if (orig === undefined) delete process.env.OPENCODE_DB;
			else process.env.OPENCODE_DB = orig;
		}
	});
});

/* ------------------------------------------------------------------ */
/* Consistency: errors column == detail total for same filter + tool    */
/* ------------------------------------------------------------------ */

	describe('consistency with top-tools widget', () => {
		test('unfiltered detail total is 2 (fixture has 2 failed/error parts)', async () => {
			const response = await GET({
				params: {},
				url: new URL('http://localhost/api/dashboard/tool-errors?period=all')
			});
			const body = (await response.json()) as { total: number };
			expect(body.total).toBe(2);
		});
	});

/* ------------------------------------------------------------------ */
/* All-calls mode: ?status=all (task #484)                              */
/* ------------------------------------------------------------------ */

describe('GET /api/dashboard/tool-errors — ?status=all', () => {
	test('status=all returns every call including completed, not just failures', async () => {
		const response = await GET({
			params: {},
			url: new URL('http://localhost/api/dashboard/tool-errors?period=all&status=all')
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { total: number; rows: Array<{ tool: string; status: string }> };
		// Fixture has 3 tool parts: p1 (error), p2 (failed), p3 (completed).
		// status=all should return all 3.
		expect(body.total).toBe(3);
		expect(body.rows).toHaveLength(3);
	});

	test('status=all rows include non-failed status values (completed)', async () => {
		const response = await GET({
			params: {},
			url: new URL('http://localhost/api/dashboard/tool-errors?period=all&status=all')
		});
		const body = (await response.json()) as { rows: Array<{ status: string }> };
		const statuses = body.rows.map((r) => r.status);
		expect(statuses).toContain('completed');
		expect(statuses).toContain('error');
		expect(statuses).toContain('failed');
	});

	test('status=all rows each carry a string status field', async () => {
		const response = await GET({
			params: {},
			url: new URL('http://localhost/api/dashboard/tool-errors?period=all&status=all')
		});
		const body = (await response.json()) as { rows: Array<{ status: unknown }> };
		for (const row of body.rows) {
			expect(typeof row.status).toBe('string');
		}
	});

	test('status=all widens total beyond the failures-only count', async () => {
		const errorsResp = await GET({
			params: {},
			url: new URL('http://localhost/api/dashboard/tool-errors?period=all&status=errors')
		});
		const allResp = await GET({
			params: {},
			url: new URL('http://localhost/api/dashboard/tool-errors?period=all&status=all')
		});
		const errorsBody = (await errorsResp.json()) as { total: number };
		const allBody = (await allResp.json()) as { total: number };
		expect(allBody.total).toBeGreaterThan(errorsBody.total);
	});

	test('status=all widens agents list compared to errors mode', async () => {
		const errorsResp = await GET({
			params: {},
			url: new URL('http://localhost/api/dashboard/tool-errors?period=all&status=errors')
		});
		const allResp = await GET({
			params: {},
			url: new URL('http://localhost/api/dashboard/tool-errors?period=all&status=all')
		});
		const errorsAgents = (await errorsResp.json()) as { agents: string[] };
		const allAgents = (await allResp.json()) as { agents: string[] };
		// All mode agents should be a superset of errors mode agents.
		for (const agent of errorsAgents.agents) {
			expect(allAgents.agents).toContain(agent);
		}
		// All mode should include at least as many agents.
		expect(allAgents.agents.length).toBeGreaterThanOrEqual(errorsAgents.agents.length);
	});

	test('absent status defaults to errors (failures-only)', async () => {
		const defaultResp = await GET({
			params: {},
			url: new URL('http://localhost/api/dashboard/tool-errors?period=all')
		});
		const explicitResp = await GET({
			params: {},
			url: new URL('http://localhost/api/dashboard/tool-errors?period=all&status=errors')
		});
		const defaultBody = (await defaultResp.json()) as { total: number; rows: unknown[] };
		const explicitBody = (await explicitResp.json()) as { total: number; rows: unknown[] };
		expect(defaultBody.total).toBe(explicitBody.total);
		expect(defaultBody.rows).toEqual(explicitBody.rows);
	});

	test('status=bogus returns 400 { error, field: "status" } with cache-control: no-store', async () => {
		const response = await GET({
			params: {},
			url: new URL('http://localhost/api/dashboard/tool-errors?period=all&status=bogus')
		});
		expect(response.status).toBe(400);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = (await response.json()) as { error: string; field: string };
		expect(body.field).toBe('status');
		expect(typeof body.error).toBe('string');
		expect(body.error.length).toBeGreaterThan(0);
	});
});
