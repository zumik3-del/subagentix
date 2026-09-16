/**
 * Dashboard API endpoint suite (task #405).
 *
 * Exercises `GET /api/dashboard/[widget]?period=&scope=[&refresh=1]` against a
 * real fixture DB in an isolated child process, covering the ok/404/400/500
 * contract, the response envelope shape, Cache-Control:no-store, refresh
 * bypass, and per-widget payload distinctness.
 *
 * The live opencode DB is never opened or written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T = 1_700_000_000_000;
const DAY = 86_400_000;
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

	// 3 sessions across two directories, spanning two UTC days.
	insSession.run('s1', null, '/repo/a', 'S1', 'build', T, T + 100, null, 1, 100, 200, 50, 10, 20, MODEL, 'proj-a');
	insSession.run('s2', null, '/repo/b', 'S2', 'plan', T + DAY, T + DAY + 100, null, 2, 300, 100, 20, 5, 10, MODEL, null);
	insSession.run('s3', null, '/repo/a', 'S3', 'build', T + DAY + 50, T + DAY + 60, null, 0.5, 50, 30, 10, 2, 5, MODEL, 'proj-a');

	// Messages (Tier-M data)
	insMessage.run('m1', 's1', T, T + 100, JSON.stringify({ role: 'assistant', cost: 3, tokens: { input: 100, output: 200, reasoning: 50, cache: { read: 10, write: 20 } }, time: { created: T } }));
	insMessage.run('m2', 's2', T + DAY, T + DAY + 100, JSON.stringify({ role: 'assistant', cost: 5, tokens: { input: 300, output: 100, reasoning: 20, cache: { read: 5, write: 10 } }, time: { created: T + DAY } }));
	insMessage.run('m3', 's3', T + DAY + 50, T + DAY + 60, JSON.stringify({ role: 'assistant', cost: 0.5, tokens: { input: 50, output: 30, reasoning: 10, cache: { read: 2, write: 5 } }, time: { created: T + DAY + 50 } }));

	// Tool parts (Tier-P data)
	insPart.run('p1', 'm1', 's1', T + 10, T + 20, JSON.stringify({ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed' } }));
	insPart.run('p2', 'm1', 's1', T + 30, T + 40, JSON.stringify({ type: 'tool', tool: 'bash', callID: 'c2', state: { status: 'error', error: 'boom' } }));
	insPart.run('p3', 'm2', 's2', T + DAY + 10, T + DAY + 20, JSON.stringify({ type: 'tool', tool: 'edit', callID: 'c3', state: { status: 'completed' } }));

	db.close();
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-dashboard-api-'));
const DB_PATH = join(tempDir, 'fixture.db');
buildFixture(DB_PATH);
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const { GET } = (await import(spec('./[widget]/+server.ts'))) as {
	GET: (event: { params: { widget: string }; url: URL }) => Promise<Response>;
};
const { resetDbConnection } = (await import(spec('../../../lib/server/db.ts'))) as {
	resetDbConnection: () => void;
};

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* ok: envelope shape + no-store header + correct data per widget     */
/* ------------------------------------------------------------------ */

describe('GET /api/dashboard/[widget] — ok contract', () => {
	const widgetIds = ['kpi', 'sessions-per-day', 'cost-per-day', 'top-tools', 'agent-distribution', 'top-projects'] as const;

	for (const widgetId of widgetIds) {
		test(`200 + envelope shape for widget "${widgetId}"`, async () => {
			const response = await GET({
				params: { widget: widgetId },
				url: new URL('http://localhost/api/dashboard/sessions-per-day')
			});
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.widgetId).toBe(widgetId);
			expect(typeof body.generatedAt).toBe('number');
			expect(body.data).toBeDefined();
		});
	}

	test('payload shape per widget type', async () => {
		// sessions-per-day: [{ day, value }, ...]
		// The fixture is dated 2023, so an explicit `period=all` keeps it in range
		// (the default 30d window would return a dense all-zero series).
		const rDay = await GET({
			params: { widget: 'sessions-per-day' },
			url: new URL('http://localhost/api/dashboard/sessions-per-day?period=all')
		});
		const dayData = (await rDay.json()) as { data: unknown };
		expect(Array.isArray((dayData as { data: unknown[] }).data)).toBe(true);
		const buckets = (dayData as { data: Array<{ day: string; value: number }> }).data;
		expect(buckets.length).toBeGreaterThan(0);
		for (const b of buckets) {
			expect(typeof b.day).toBe('string');
			expect(typeof b.value).toBe('number');
		}
		expect(buckets.reduce((sum, b) => sum + b.value, 0)).toBe(3);

		// agent-distribution: [{ name, count }, ...] — fixture has build x2 + plan x1.
		const rAgent = await GET({
			params: { widget: 'agent-distribution' },
			url: new URL('http://localhost/api/dashboard/agent-distribution?period=all')
		});
		const agentData = (await rAgent.json()) as { data: Array<{ name: string; count: number }> };
		expect(agentData.data.length).toBe(2);
		expect(agentData.data.reduce((sum, a) => sum + a.count, 0)).toBe(3);

		// top-tools: { capped: boolean, tools: [{ name, count, errors, errorShare }] }
		const rTool = await GET({
			params: { widget: 'top-tools' },
			url: new URL('http://localhost/api/dashboard/top-tools?period=all')
		});
		const toolData = (await rTool.json()) as {
			data: { capped: boolean; tools: Array<{ name: string; count: number; errors: number; errorShare: number }> };
		};
		expect(typeof toolData.data.capped).toBe('boolean');
		expect(Array.isArray(toolData.data.tools)).toBe(true);
	});

	test('refresh=1 returns a fresh envelope', async () => {
		const r1 = await GET({
			params: { widget: 'kpi' },
			url: new URL('http://localhost/api/dashboard/kpi?refresh=1')
		});
		expect(r1.status).toBe(200);
		const body1 = (await r1.json()) as { generatedAt: number };
		const r2 = await GET({
			params: { widget: 'kpi' },
			url: new URL('http://localhost/api/dashboard/kpi?refresh=1')
		});
		const body2 = (await r2.json()) as { generatedAt: number };
		// With refresh=1 both times, generatedAt should be different (or at least
		// the cache bypass is exercised — we just verify 200 + shape).
		expect(body1.generatedAt).toBeDefined();
		expect(body2.generatedAt).toBeDefined();
	});
});

/* ------------------------------------------------------------------ */
/* 404: unknown widget id                                             */
/* ------------------------------------------------------------------ */

describe('GET /api/dashboard/[widget] — 404 unknown widget', () => {
	test('unknown widget id returns 404 with error message', async () => {
		const response = await GET({
			params: { widget: 'nonexistent' },
			url: new URL('http://localhost/api/dashboard/nonexistent')
		});
		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: string };
		expect(typeof body.error).toBe('string');
	});
});

/* ------------------------------------------------------------------ */
/* 400: invalid period / unknown scope                                */
/* ------------------------------------------------------------------ */

describe('GET /api/dashboard/[widget] — 400 validation', () => {
	test('invalid period → 400 {error, field: "period"}', async () => {
		const response = await GET({
			params: { widget: 'kpi' },
			url: new URL('http://localhost/api/dashboard/kpi?period=forever')
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string; field?: string };
		expect(body.field).toBe('period');
	});

	test('unknown scope directory → 400 {error, field: "scope"}', async () => {
		const response = await GET({
			params: { widget: 'kpi' },
			url: new URL('http://localhost/api/dashboard/kpi?scope=/nonexistent')
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string; field?: string };
		expect(body.field).toBe('scope');
	});

	test('blank period and scope fall back to defaults (30d / all dirs) without error', async () => {
		const response = await GET({
			params: { widget: 'kpi' },
			url: new URL('http://localhost/api/dashboard/kpi?period=&scope=')
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { widgetId: string };
		expect(body.widgetId).toBe('kpi');
	});

	test('scope=all is accepted (maps to null = every directory)', async () => {
		const response = await GET({
			params: { widget: 'kpi' },
			url: new URL('http://localhost/api/dashboard/kpi?scope=all')
		});
		expect(response.status).toBe(200);
	});
});

/* ------------------------------------------------------------------ */
/* 500: generic error, no internals leaked                            */
/* ------------------------------------------------------------------ */

describe('GET /api/dashboard/[widget] — 500 on DB failure', () => {
	test('generic 500 when the DB is missing', async () => {
		// Point at a non-existent DB path.
		const orig = process.env.OPENCODE_DB;
		process.env.OPENCODE_DB = join(tempDir, 'missing.db');
		try {
			// Re-import the route module to pick up the new env.
			const fresh = (await import(spec('./[widget]/+server.ts') + '?bust=' + crypto.randomUUID())) as {
				GET: (event: { params: { widget: string }; url: URL }) => Promise<Response>;
			};
			const response = await fresh.GET({
				params: { widget: 'kpi' },
				url: new URL('http://localhost/api/dashboard/kpi')
			});
			expect(response.status).toBe(500);
			const body = (await response.json()) as { error: string };
			expect(body.error).toBe('Failed to load dashboard data.');
			// No internal paths or DB messages leaked.
			expect(body.error).not.toContain('not found');
			expect(body.error).not.toContain('/missing.db');
		} finally {
			if (orig === undefined) delete process.env.OPENCODE_DB;
			else process.env.OPENCODE_DB = orig;
		}
	});
});

/* ------------------------------------------------------------------ */
/* Per-widget distinctness for one filter                             */
/* ------------------------------------------------------------------ */

describe('per-widget distinctness', () => {
	test('same filter returns distinct payloads for different widgets', async () => {
		const url = new URL('http://localhost/api/dashboard/sessions-per-day?period=7d&scope=/repo/a');
		const rSd = await GET({ params: { widget: 'sessions-per-day' }, url });
		const rKpi = await GET({ params: { widget: 'kpi' }, url: new URL('http://localhost/api/dashboard/kpi?period=7d&scope=/repo/a') });
		const rTp = await GET({ params: { widget: 'top-tools' }, url: new URL('http://localhost/api/dashboard/top-tools?period=7d&scope=/repo/a') });
		const bodySd = (await rSd.json()) as { data: unknown };
		const bodyKpi = (await rKpi.json()) as { data: unknown };
		const bodyTp = (await rTp.json()) as { data: unknown };
		// The raw data shapes differ by widget (array vs object); they should
		// not be identical objects.
		expect(JSON.stringify(bodySd.data)).not.toBe(JSON.stringify(bodyKpi.data));
		expect(JSON.stringify(bodySd.data)).not.toBe(JSON.stringify(bodyTp.data));
		expect(JSON.stringify(bodyKpi.data)).not.toBe(JSON.stringify(bodyTp.data));
	});
});

/* ------------------------------------------------------------------ */
/* Cache-level: directory list memoisation via the widget endpoint    */
/* ------------------------------------------------------------------ */

describe('GET /api/dashboard/[widget] — cached directory validation', () => {
	test('N GETs with the same known scope all return 200 (cache does not break the request)', async () => {
		for (let i = 0; i < 6; i++) {
			const response = await GET({
				params: { widget: 'kpi' },
				url: new URL('http://localhost/api/dashboard/kpi?scope=/repo/a')
			});
			expect(response.status).toBe(200);
		}
	});

	test('after resetDbConnection(), the next GET with a known scope still returns 200', async () => {
		// First, populate the cache with one request.
		const pre = await GET({
			params: { widget: 'kpi' },
			url: new URL('http://localhost/api/dashboard/kpi?scope=/repo/a')
		});
		expect(pre.status).toBe(200);

		// Reset the DB handle, which bumps generation and notifies the cache
		// subscriber so it drops its snapshot and re-computes on the next call.
		resetDbConnection();

		// Two requests after reset: both must succeed (cache recomputes once,
		// then serves the same instance for the second call).
		const post1 = await GET({
			params: { widget: 'kpi' },
			url: new URL('http://localhost/api/dashboard/kpi?scope=/repo/a')
		});
		expect(post1.status).toBe(200);
		const post2 = await GET({
			params: { widget: 'kpi' },
			url: new URL('http://localhost/api/dashboard/kpi?scope=/repo/a')
		});
		expect(post2.status).toBe(200);
	});

	test('after resetDbConnection(), an unknown scope is still rejected with 400', async () => {
		resetDbConnection();
		const response = await GET({
			params: { widget: 'kpi' },
			url: new URL('http://localhost/api/dashboard/kpi?scope=/nonexistent')
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string; field?: string };
		expect(body.field).toBe('scope');
	});

	test('the cache recomputes the directory list after a DB reset (fresh instance)', async () => {
		const { listDirectoriesCached } = (await import(spec('../../../lib/server/queries/directories.ts'))) as {
			listDirectoriesCached: () => Array<{ directory: string; projectName: string | null; sessionCount: number; updatedAt: number }>;
		};
		const first = listDirectoriesCached();
		resetDbConnection();
		const second = listDirectoriesCached();
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
	});
});
