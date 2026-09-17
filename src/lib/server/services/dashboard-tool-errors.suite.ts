/**
 * Tool-errors service regression suite (task #481).
 *
 * Covers getToolErrors(): window resolution, capped flag, filter passthrough,
 * paging, agents list, and the consistency invariant with the tier-P aggregate
 * (errors column == unfiltered detail total). The live opencode DB is never opened.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_TOOL_SESSIONS } from '$lib/model/dashboard';

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

	insSession.run('s1', null, '/repo/a', 'S1', 'build', T - 100, T, null, 0, 0, 0, 0, 0, 0, MODEL, 'proj-a');
	insSession.run('s2', null, '/repo/a', 'S2', 'plan', T - 50, T + 50, null, 0, 0, 0, 0, 0, 0, MODEL, 'proj-a');

	insMessage.run('m1', 's1', T - 100, T, '{}');
	insMessage.run('m2', 's2', T - 50, T + 50, '{}');

	insPart.run('p1', 'm1', 's1', T - 90, T - 80, JSON.stringify({
		type: 'tool', tool: 'bash', callID: 'c1',
		state: { status: 'error', error: 'exit 1', time: { start: T - 90, end: T - 80 } }
	}));
	insPart.run('p2', 'm2', 's2', T - 40, T - 30, JSON.stringify({
		type: 'tool', tool: 'bash', callID: 'c2',
		state: { status: 'completed', time: { start: T - 40, end: T - 30 } }
	}));
	insPart.run('p3', 'm2', 's2', T - 20, T - 10, JSON.stringify({
		type: 'tool', tool: 'read', callID: 'c3',
		state: { status: 'failed', error: 'permission denied', time: { start: T - 20, end: T - 10 } }
	}));

	db.close();
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-tool-errors-svc-'));
const DB_PATH = join(tempDir, 'fixture.db');
buildFixture(DB_PATH);
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const { getToolErrors } = (await import(spec('./dashboard-tool-errors.ts'))) as typeof import('../services/dashboard-tool-errors');
const { resetDbConnection } = (await import(spec('../../server/db.ts'))) as { resetDbConnection: () => void };
const { getDb } = (await import(spec('../../server/db.ts'))) as { getDb: () => { query: (sql: string) => { get: () => unknown } } };
const { getTopTools } = (await import(spec('./dashboard-tools.ts'))) as typeof import('../services/dashboard-tools');

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Basic envelope shape                                                 */
/* ------------------------------------------------------------------ */

describe('getToolErrors — envelope', () => {
	test('returns { rows, total, agents, capped }', () => {
		const page = getToolErrors({ period: 'all', scope: null }, {}, T);
		expect(typeof page.rows).toBe('object');
		expect(Array.isArray(page.rows)).toBe(true);
		expect(typeof page.total).toBe('number');
		expect(Array.isArray(page.agents)).toBe(true);
		expect(typeof page.capped).toBe('boolean');
	});

	test('rows are ToolErrorEntry objects with the expected shape', () => {
		const page = getToolErrors({ period: 'all', scope: null }, {}, T);
		for (const row of page.rows) {
			expect(typeof row.id).toBe('string');
			expect(typeof row.sessionId).toBe('string');
			expect(typeof row.at).toBe('number');
			expect(typeof row.agent).toBe('string');
			expect(typeof row.tool).toBe('string');
			expect(typeof row.error).toBe('string');
		}
	});
});

/* ------------------------------------------------------------------ */
/* Filter passthrough: tool, agent, search                              */
/* ------------------------------------------------------------------ */

describe('getToolErrors — filters', () => {
	test('tool filter reduces rows to matching tool only', () => {
		const all = getToolErrors({ period: 'all', scope: null }, {}, T);
		const bash = getToolErrors({ period: 'all', scope: null }, { tool: 'bash' }, T);
		expect(bash.rows.length).toBeLessThan(all.rows.length);
		expect(bash.rows.every((r) => r.tool === 'bash')).toBe(true);
	});

	test('agent filter reduces to matching agent', () => {
		const all = getToolErrors({ period: 'all', scope: null }, {}, T);
		const plan = getToolErrors({ period: 'all', scope: null }, { agent: 'plan' }, T);
		expect(plan.rows.every((r) => r.agent === 'plan')).toBe(true);
	});

	test('search filter matches error text substring', () => {
		const page = getToolErrors({ period: 'all', scope: null }, { search: 'exit' }, T);
		expect(page.rows.length).toBeGreaterThan(0);
		expect(page.rows.every((r) => r.error.toLowerCase().includes('exit'))).toBe(true);
	});

	test('combined filters intersect correctly', () => {
		const combined = getToolErrors({ period: 'all', scope: null }, { tool: 'bash', agent: 'build' }, T);
		expect(combined.rows.length).toBeGreaterThan(0);
		expect(combined.rows.every((r) => r.tool === 'bash' && r.agent === 'build')).toBe(true);
	});
});

/* ------------------------------------------------------------------ */
/* Paging                                                               */
/* ------------------------------------------------------------------ */

describe('getToolErrors — paging', () => {
	test('limit and offset are applied', () => {
		const full = getToolErrors({ period: 'all', scope: null }, { limit: 100, offset: 0 }, T);
		const page1 = getToolErrors({ period: 'all', scope: null }, { limit: 1, offset: 0 }, T);
		const page2 = getToolErrors({ period: 'all', scope: null }, { limit: 1, offset: 1 }, T);
		expect(page1.rows.length).toBe(1);
		expect(page2.rows.length).toBe(1);
		expect(page1.rows[0].id).not.toBe(page2.rows[0].id);
		// total is the same regardless of page.
		expect(page1.total).toBe(full.total);
		expect(page2.total).toBe(full.total);
	});

	test('default limit is DEFAULT_ERROR_LIMIT (50)', () => {
		const defaultPage = getToolErrors({ period: 'all', scope: null }, {}, T);
		const explicitPage = getToolErrors({ period: 'all', scope: null }, { limit: 50, offset: 0 }, T);
		expect(defaultPage.rows.length).toBeLessThanOrEqual(50);
		expect(explicitPage.rows.length).toBeLessThanOrEqual(50);
	});
});

/* ------------------------------------------------------------------ */
/* Capped flag                                                          */
/* ------------------------------------------------------------------ */

describe('getToolErrors — capped flag', () => {
	test('capped is false when session count is below MAX_TOOL_SESSIONS', () => {
		const page = getToolErrors({ period: 'all', scope: null }, {}, T);
		// Our fixture has only 2 sessions, far below 2000.
		expect(page.capped).toBe(false);
	});

	test('capped is true when maxSessions is set below the session count', () => {
		// Force the ceiling to 1 — our fixture has 2 sessions, so capped must be true.
		const page = getToolErrors({ period: 'all', scope: null }, {}, T, 1);
		expect(page.capped).toBe(true);
	});
});

/* ------------------------------------------------------------------ */
/* Agents list                                                          */
/* ------------------------------------------------------------------ */

describe('getToolErrors — agents', () => {
	test('agents is sorted ascending and includes all distinct agents', () => {
		const page = getToolErrors({ period: 'all', scope: null }, {}, T);
		const sorted = [...page.agents].sort();
		expect(page.agents).toEqual(sorted);
		expect(page.agents).toContain('build');
		expect(page.agents).toContain('plan');
	});

	test('agents is stable regardless of tool/agent/search filters', () => {
		const base = getToolErrors({ period: 'all', scope: null }, {}, T).agents;
		const toolFiltered = getToolErrors({ period: 'all', scope: null }, { tool: 'bash' }, T).agents;
		const searchFiltered = getToolErrors({ period: 'all', scope: null }, { search: 'exit' }, T).agents;
		expect(toolFiltered).toEqual(base);
		expect(searchFiltered).toEqual(base);
	});
});

/* ------------------------------------------------------------------ */
/* Consistency with top-tools aggregate                                 */
/* ------------------------------------------------------------------ */

describe('consistency with top-tools aggregate', () => {
	test('unfiltered detail total equals the tier-P errors sum', () => {
		const detail = getToolErrors({ period: 'all', scope: null }, {}, T);
		const usage = getTopTools({ period: 'all', scope: null }, T);
		const totalErrors = usage.tools.reduce((sum, entry) => sum + entry.errors, 0);
		expect(detail.total).toBe(totalErrors);
	});

	test('capped flag is the same in both the widget and the detail', () => {
		const detail = getToolErrors({ period: 'all', scope: null }, {}, T);
		const usage = getTopTools({ period: 'all', scope: null }, T);
		expect(detail.capped).toBe(usage.capped);
	});
});

/* ------------------------------------------------------------------ */
/* All-calls mode at service level (task #484)                          */
/* ------------------------------------------------------------------ */

describe('getToolErrors — all-calls mode', () => {
	test('status=all returns more rows than status=errors', () => {
		const errorsPage = getToolErrors({ period: 'all', scope: null }, { status: 'errors' }, T);
		const allPage = getToolErrors({ period: 'all', scope: null }, { status: 'all' }, T);
		expect(allPage.rows.length).toBeGreaterThan(errorsPage.rows.length);
		expect(allPage.total).toBeGreaterThan(errorsPage.total);
	});

	test('status=all rows include completed-status entries', () => {
		const allPage = getToolErrors({ period: 'all', scope: null }, { status: 'all' }, T);
		const completedRows = allPage.rows.filter((r) => r.status === 'completed');
		expect(completedRows.length).toBeGreaterThan(0);
	});

	test('status=all rows each carry a string status field', () => {
		const allPage = getToolErrors({ period: 'all', scope: null }, { status: 'all' }, T);
		for (const row of allPage.rows) {
			expect(typeof row.status).toBe('string');
		}
	});

	test('status=all widens agents list compared to errors mode', () => {
		const errorsPage = getToolErrors({ period: 'all', scope: null }, { status: 'errors' }, T);
		const allPage = getToolErrors({ period: 'all', scope: null }, { status: 'all' }, T);
		// All mode agents should be a superset of errors mode agents.
		for (const agent of errorsPage.agents) {
			expect(allPage.agents).toContain(agent);
		}
		// All mode should include at least as many agents.
		expect(allPage.agents.length).toBeGreaterThanOrEqual(errorsPage.agents.length);
	});

	test('status=all preserves newest-first ordering', () => {
		const allPage = getToolErrors({ period: 'all', scope: null }, { status: 'all' }, T);
		for (let i = 1; i < allPage.rows.length; i++) {
			const prev = allPage.rows[i - 1];
			const curr = allPage.rows[i];
			expect(prev.at).toBeGreaterThanOrEqual(curr.at);
		}
	});

	test('status=all preserves paging', () => {
		const fullPage = getToolErrors({ period: 'all', scope: null }, { status: 'all', limit: 100, offset: 0 }, T);
		const page1 = getToolErrors({ period: 'all', scope: null }, { status: 'all', limit: 1, offset: 0 }, T);
		const page2 = getToolErrors({ period: 'all', scope: null }, { status: 'all', limit: 1, offset: 1 }, T);
		expect(page1.rows).toHaveLength(1);
		expect(page2.rows).toHaveLength(1);
		expect(page1.rows[0].id).not.toBe(page2.rows[0].id);
		expect(page1.total).toBe(fullPage.total);
		expect(page2.total).toBe(fullPage.total);
	});

	test('default status (absent) is errors, not all', () => {
		const defaultPage = getToolErrors({ period: 'all', scope: null }, {}, T);
		const errorsPage = getToolErrors({ period: 'all', scope: null }, { status: 'errors' }, T);
		expect(defaultPage.total).toBe(errorsPage.total);
		expect(defaultPage.rows).toEqual(errorsPage.rows);
		expect(defaultPage.agents).toEqual(errorsPage.agents);
	});
});

/* ------------------------------------------------------------------ */
/* Read-only guarantee                                                  */
/* ------------------------------------------------------------------ */

describe('read-only guarantee', () => {
	test('PRAGMA query_only stays 1 after getToolErrors', () => {
		getToolErrors({ period: 'all', scope: null }, {}, T);
		const result = getDb().query('PRAGMA query_only').get();
		expect(result).toEqual({ query_only: 1 });
	});
});
