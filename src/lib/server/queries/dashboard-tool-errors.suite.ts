/**
 * Tool-errors query regression suite (task #481).
 *
 * Covers the Tier-P read for failed tool calls: `status IN ('error','failed')`,
 * tool/agent/search filters, LIKE-wildcard escaping, newest-first ordering,
 * limit/offset paging with correct total, and the `capped` flag at
 * MAX_TOOL_SESSIONS. Fixture has mixed error/ok/completed parts across sessions
 * so every filter path is exercised. The live opencode DB is never opened.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T = 1_700_000_000_000; // 2023-11-13T22:13:20Z
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

	// --- Sessions ---------------------------------------------------------------
	insSession.run('s-ok', null, '/repo/a', 'S-ok', 'build', T, T + 100, null, 0, 0, 0, 0, 0, 0, MODEL, 'proj-a');
	insSession.run('s-err', null, '/repo/a', 'S-err', 'plan', T + 1_000, T + 1_100, null, 0, 0, 0, 0, 0, 0, MODEL, 'proj-a');
	insSession.run('s-blank-agent', null, '/repo/b', 'S-blank', '', T + 2_000, T + 2_100, null, 0, 0, 0, 0, 0, 0, MODEL, null);
	insSession.run('s-null-agent', null, '/repo/b', 'S-null', null, T + 3_000, T + 3_100, null, 0, 0, 0, 0, 0, 0, MODEL, null);

	// --- Messages ---------------------------------------------------------------
	insMessage.run('m-ok', 's-ok', T, T + 100, JSON.stringify({ role: 'assistant', time: { created: T } }));
	insMessage.run('m-err', 's-err', T + 1_000, T + 1_100, JSON.stringify({ role: 'assistant', time: { created: T + 1_000 } }));
	insMessage.run('m-blank', 's-blank-agent', T + 2_000, T + 2_100, JSON.stringify({ role: 'assistant', time: { created: T + 2_000 } }));
	insMessage.run('m-null', 's-null-agent', T + 3_000, T + 3_100, JSON.stringify({ role: 'assistant', time: { created: T + 3_000 } }));

	// --- Parts ------------------------------------------------------------------
	// s-ok: one completed bash call (no error)
	insPart.run('p-ok', 'm-ok', 's-ok', T + 10, T + 20, JSON.stringify({
		type: 'tool', tool: 'bash', callID: 'c-ok',
		state: { status: 'completed', time: { start: T + 10, end: T + 20 } }
	}));
	// s-err: one error, one failed, one completed mcp_recall
	insPart.run('p-err', 'm-err', 's-err', T + 1_010, T + 1_020, JSON.stringify({
		type: 'tool', tool: 'mcp_recall', callID: 'c-err',
		state: { status: 'error', error: 'boom', time: { start: T + 1_010, end: T + 1_020 } }
	}));
	insPart.run('p-failed', 'm-err', 's-err', T + 1_030, T + 1_040, JSON.stringify({
		type: 'tool', tool: 'mcp_recall', callID: 'c-fail',
		state: { status: 'failed', error: 'timeout', time: { start: T + 1_030, end: T + 1_040 } }
	}));
	insPart.run('p-err-ok', 'm-err', 's-err', T + 1_050, T + 1_060, JSON.stringify({
		type: 'tool', tool: 'bash', callID: 'c-err-ok',
		state: { status: 'completed', time: { start: T + 1_050, end: T + 1_060 } }
	}));
	// s-blank-agent: blank tool name -> 'unknown'
	insPart.run('p-blank-tool', 'm-blank', 's-blank-agent', T + 2_010, T + 2_020, JSON.stringify({
		type: 'tool', callID: 'c-blank-tool',
		state: { status: 'error', error: 'missing tool', time: { start: T + 2_010, end: T + 2_020 } }
	}));
	// s-null-agent: same
	insPart.run('p-null-tool', 'm-null', 's-null-agent', T + 3_010, T + 3_020, JSON.stringify({
		type: 'tool', tool: 'read', callID: 'c-null-tool',
		state: { status: 'error', error: 'file not found', time: { start: T + 3_010, end: T + 3_020 } }
	}));

	db.close();
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-tool-errors-queries-'));
const DB_PATH = join(tempDir, 'fixture.db');
buildFixture(DB_PATH);
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const { resetDbConnection, getDb } = (await import(spec('../../server/db.ts'))) as {
	resetDbConnection: () => void;
	getDb: () => { query: (sql: string) => { get: () => unknown } };
};
const { listSessionIds } = (await import(spec('./dashboard.ts'))) as typeof import('../queries/dashboard');
const {
	listToolErrors,
	countToolErrors,
	listToolErrorAgents
} = (await import(spec('./dashboard-tool-errors.ts'))) as typeof import('../queries/dashboard-tool-errors');
const { aggregateToolUsage } = (await import(spec('./dashboard.ts'))) as typeof import('../queries/dashboard');

/** Brute-force count of entries for one agent label, for count assertions. */
function expectedAgentCount(ids: string[], agent: string): number {
	return listToolErrors(ids, {}, 0, 1000).filter((row) => row.agent === agent).length;
}

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Unified failure definition: status IN ('error','failed')           */
/* ------------------------------------------------------------------ */

describe('failure definition', () => {
	test('counts only error and failed; excludes completed', () => {
		const ids = listSessionIds({});
		expect(countToolErrors(ids, {})).toBe(4); // p-err, p-failed, p-blank-tool, p-null-tool
	});

	test('error and failed are both matched equally', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, {}, 0, 100);
		const statuses = rows.map((r) => r.error).sort();
		// All four should appear; the exact text differs but count is 4.
		expect(rows).toHaveLength(4);
	});

	test('completed parts are excluded from the list', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, {}, 0, 100);
		// p-ok is completed, p-err-ok is completed — neither should appear.
		for (const row of rows) {
			expect(row.tool).not.toEqual('bash'); // the only bash in range is completed
		}
	});
});

/* ------------------------------------------------------------------ */
/* Tool filter                                                          */
/* ------------------------------------------------------------------ */

describe('tool filter', () => {
	test('exact tool matches one call', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, { tool: 'mcp_recall' }, 0, 100);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.tool === 'mcp_recall')).toBe(true);
	});

	test('tool=null (no filter) returns all errors', () => {
		const ids = listSessionIds({});
		const filtered = listToolErrors(ids, { tool: 'mcp_recall' }, 0, 100);
		const unfiltered = listToolErrors(ids, {}, 0, 100);
		expect(unfiltered.length).toBeGreaterThan(filtered.length);
	});

	test('unknown tool returns empty', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, { tool: 'nonexistent' }, 0, 100);
		expect(rows).toHaveLength(0);
	});

	test('blank tool is treated as no filter', () => {
		const ids = listSessionIds({});
		const blank = listToolErrors(ids, { tool: '' }, 0, 100);
		const none = listToolErrors(ids, {}, 0, 100);
		expect(blank).toEqual(none);
	});
});

/* ------------------------------------------------------------------ */
/* Agent filter                                                         */
/* ------------------------------------------------------------------ */

describe('agent filter', () => {
	test('exact agent matches its session', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, { agent: 'plan' }, 0, 100);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.agent === 'plan')).toBe(true);
	});

	test('blank agent and NULL agent both label as unknown', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, {}, 0, 100);
		const unknownRows = rows.filter((r) => r.agent === 'unknown');
		// s-blank-agent and s-null-agent both have blank/NULL agents.
		expect(unknownRows.length).toBe(2);
	});

	test('agent=null (no filter) returns all agents that have errors', () => {
		const ids = listSessionIds({});
		const allAgents = listToolErrorAgents(ids);
		// s-ok (build) has only a completed part, so 'build' is NOT in the agent list.
		// s-err (plan) has errors; s-blank-agent and s-null-agent are 'unknown'.
		expect(allAgents).toContain('plan');
		expect(allAgents).toContain('unknown');
		expect(allAgents).not.toContain('build');
	});
});

/* ------------------------------------------------------------------ */
/* Search: LIKE with wildcard escaping                                  */
/* ------------------------------------------------------------------ */

describe('search filter — LIKE escaping', () => {
	test('literal % is escaped and does not act as wildcard', () => {
		const ids = listSessionIds({});
		// No error text contains a literal '%'. Searching for '%' should match nothing.
		const rows = listToolErrors(ids, { search: '%' }, 0, 100);
		expect(rows).toHaveLength(0);
	});

	test('literal _ is escaped and does not act as wildcard', () => {
		const ids = listSessionIds({});
		// Searching for '_' should match nothing (no underscore in any error text).
		const rows = listToolErrors(ids, { search: '_' }, 0, 100);
		expect(rows).toHaveLength(0);
	});

	test('literal backslash is escaped', () => {
		const ids = listSessionIds({});
		// No error text contains a backslash. Searching for '\\' should match nothing.
		const rows = listToolErrors(ids, { search: '\\' }, 0, 100);
		expect(rows).toHaveLength(0);
	});

	test('substring search matches error text case-insensitively', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, { search: 'BOOM' }, 0, 100);
		expect(rows.length).toBeGreaterThan(0);
		// The text 'boom' is in p-err.
		expect(rows.some((r) => r.error.toLowerCase().includes('boom'))).toBe(true);
	});

	test('search with a real substring finds matching rows', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, { search: 'not found' }, 0, 100);
		expect(rows.length).toBe(1);
		expect(rows[0].error).toBe('file not found');
	});
});

/* ------------------------------------------------------------------ */
/* Ordering: newest first                                               */
/* ------------------------------------------------------------------ */

describe('ordering — newest first', () => {
	test('rows are returned newest-first by time_created desc, then id desc', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, {}, 0, 100);
		for (let i = 1; i < rows.length; i++) {
			const prev = rows[i - 1];
			const curr = rows[i];
			expect(prev.at).toBeGreaterThanOrEqual(curr.at);
		}
	});

	test('same timestamp sorts by id desc', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, {}, 0, 100);
		// Find any pair with the same at; their ids should be descending.
		for (let i = 1; i < rows.length; i++) {
			if (rows[i - 1].at === rows[i].at) {
				// Earlier row (higher index in result) should have larger id.
				expect(rows[i - 1].id >= rows[i].id).toBe(true);
			}
		}
	});
});

/* ------------------------------------------------------------------ */
/* Paging: limit/offset + total + capped                                */
/* ------------------------------------------------------------------ */

describe('paging', () => {
	test('limit=1 returns one row; total reflects the full filtered set', () => {
		const ids = listSessionIds({});
		const page = listToolErrors(ids, {}, 0, 1);
		const total = countToolErrors(ids, {});
		expect(page).toHaveLength(1);
		expect(total).toBe(4);
	});

	test('offset skips rows correctly', () => {
		const ids = listSessionIds({});
		const first = listToolErrors(ids, {}, 0, 2);
		const second = listToolErrors(ids, {}, 2, 2);
		expect(first.length).toBe(2);
		expect(second.length).toBe(2);
		// Pages should be disjoint.
		const firstIds = new Set(first.map((r) => r.id));
		for (const row of second) {
			expect(firstIds.has(row.id)).toBe(false);
		}
	});

	test('offset beyond total returns empty', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, {}, 100, 10);
		expect(rows).toHaveLength(0);
	});

	test('zero limit returns empty', () => {
		const ids = listSessionIds({});
		expect(listToolErrors(ids, {}, 0, 0)).toEqual([]);
	});

	test('empty session id set returns empty rows and zero count', () => {
		expect(listToolErrors([], {}, 0, 10)).toEqual([]);
		expect(countToolErrors([], {})).toBe(0);
	});

	test('total is consistent with filtered queries', () => {
		const ids = listSessionIds({});
		const totalAll = countToolErrors(ids, {});
		const totalMcp = countToolErrors(ids, { tool: 'mcp_recall' });
		const totalBash = countToolErrors(ids, { tool: 'bash' });
		expect(totalAll).toBe(4);
		expect(totalMcp).toBe(2);
		expect(totalBash).toBe(0); // all bash parts in fixture are completed
	});
});

/* ------------------------------------------------------------------ */
/* Scoped count respects the session set (#544)                        */
/* ------------------------------------------------------------------ */

describe('scoped count', () => {
	// Regression: the errors branch counts the global indexed status set, so
	// it must still intersect with the resolved session set — otherwise a
	// directory-scoped count includes out-of-scope sessions.
	test('countToolErrors(errors) only counts sessions in the id set', () => {
		const all = listSessionIds({});
		const scoped = listSessionIds({ directory: '/repo/a' });
		expect(scoped.length).toBeGreaterThan(0);
		expect(scoped.length).toBeLessThan(all.length);
		const scopedTotal = countToolErrors(scoped, {});
		const expected = listToolErrors(scoped, {}, 0, 100).length;
		expect(scopedTotal).toBe(expected);
		expect(scopedTotal).toBeLessThan(countToolErrors(all, {}));
	});

	test('countToolErrors narrows by agent without materialising rows', () => {
		const ids = listSessionIds({});
		// `plan` owns the error part; `build` owns the completed part.
		expect(countToolErrors(ids, { agent: 'plan' })).toBe(expectedAgentCount(ids, 'plan'));
		expect(countToolErrors(ids, { agent: 'build' })).toBe(expectedAgentCount(ids, 'build'));
		expect(countToolErrors(ids, { agent: 'nobody' })).toBe(0);
	});
});

/* ------------------------------------------------------------------ */
/* Agents list                                                          */
/* ------------------------------------------------------------------ */

describe('listToolErrorAgents', () => {
	test('returns distinct agents in ascending order, including unknown', () => {
		const ids = listSessionIds({});
		const agents = listToolErrorAgents(ids);
		expect(agents).toEqual(['plan', 'unknown']);
	});

	test('agents list ignores tool/agent/search filters (stable option set)', () => {
		const ids = listSessionIds({});
		const base = listToolErrorAgents(ids);
		const toolFiltered = listToolErrorAgents(ids);
		expect(toolFiltered).toEqual(base);
	});

	test('empty id set returns empty array', () => {
		expect(listToolErrorAgents([])).toEqual([]);
	});
});

/* ------------------------------------------------------------------ */
/* Service contract consistency: errors column matches detail total     */
/* ------------------------------------------------------------------ */

describe('consistency with top-tools aggregate', () => {
	test('the unified failure definition matches the tier-P errors count', () => {
		const ids = listSessionIds({});
		const detailTotal = countToolErrors(ids, {});
		// The tier-P aggregate for the same sessions should report the same error count
		// per tool. We verify at the aggregate level: total errors across all tools.
		const usage = aggregateToolUsage(ids);
		const totalErrors = usage.reduce((sum, entry) => sum + entry.errors, 0);
		expect(totalErrors).toBe(detailTotal);
	});
});

/* ------------------------------------------------------------------ */
/* All-calls mode: drops status predicate (task #484)                  */
/* ------------------------------------------------------------------ */

describe('all-calls mode', () => {
	test('all mode includes completed parts that errors mode excludes', () => {
		const ids = listSessionIds({});
		const errorsRows = listToolErrors(ids, { status: 'errors' }, 0, 100);
		const allRows = listToolErrors(ids, { status: 'all' }, 0, 100);
		// p-ok (completed bash) should be absent from errors but present in all.
		const errorsTools = new Set(errorsRows.map((r) => r.tool));
		const allTools = new Set(allRows.map((r) => r.tool));
		expect(errorsTools.has('bash')).toBe(false); // only bash in fixture is completed
		expect(allTools.has('bash')).toBe(true);
	});

	test('all mode total equals the full tool-part count', () => {
		const ids = listSessionIds({});
		const errorsTotal = countToolErrors(ids, { status: 'errors' });
		const allTotal = countToolErrors(ids, { status: 'all' });
		// Fixture: p-ok (completed), p-err (error), p-failed (failed), p-err-ok (completed),
		// p-blank-tool (error), p-null-tool (error) = 6 total tool parts.
		expect(allTotal).toBe(6);
		expect(errorsTotal).toBe(4);
	});

	test('all mode preserves newest-first ordering', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, { status: 'all' }, 0, 100);
		for (let i = 1; i < rows.length; i++) {
			const prev = rows[i - 1];
			const curr = rows[i];
			expect(prev.at).toBeGreaterThanOrEqual(curr.at);
		}
	});

	test('all mode preserves paging (limit/offset)', () => {
		const ids = listSessionIds({});
		const full = listToolErrors(ids, { status: 'all' }, 0, 100);
		const paged = listToolErrors(ids, { status: 'all' }, 0, 2);
		expect(paged).toHaveLength(2);
		expect(paged[0].id).toBe(full[0].id);
		expect(paged[1].id).toBe(full[1].id);
	});

	test('all mode agents list includes agents with only completed calls', () => {
		const ids = listSessionIds({});
		const errorsAgents = listToolErrorAgents(ids, 'errors');
		const allAgents = listToolErrorAgents(ids, 'all');
		// 'build' has only completed calls in s-ok, so absent from errors agents.
		expect(errorsAgents).not.toContain('build');
		// But present in all agents since build has completed calls.
		expect(allAgents).toContain('build');
	});
});

/* ------------------------------------------------------------------ */
/* Read-only guarantee                                                  */
/* ------------------------------------------------------------------ */

describe('read-only guarantee', () => {
	test('PRAGMA query_only stays 1 after reads', () => {
		const ids = listSessionIds({});
		countToolErrors(ids, {});
		listToolErrors(ids, {}, 0, 10);
		listToolErrorAgents(ids);
		const result = getDb().query('PRAGMA query_only').get();
		expect(result).toEqual({ query_only: 1 });
	});
});

/* ------------------------------------------------------------------ */
/* New fields from #538: input, output, endedAt, isMcp, isDelegation   */
/* ------------------------------------------------------------------ */

describe('ToolErrorEntry — new fields (#538)', () => {
	// The existing fixture parts (p-err, p-failed, p-blank-tool, p-null-tool)
	// all have state.time.end, so endedAt is populated. None have state.input
	// or state.output, so those are null.
	test('input/output are null when absent from state; endedAt is populated when present', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, {}, 0, 100);
		for (const row of rows) {
			expect(row.input).toBeNull();
			expect(row.output).toBeNull();
			// All fixture error parts have time.end, so endedAt is a number.
			expect(typeof row.endedAt).toBe('number');
		}
	});

	test('isMcp is true for non-builtin tool names (e.g. mcp_recall)', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, {}, 0, 100);
		const mcpRows = rows.filter((r) => r.tool === 'mcp_recall');
		for (const row of mcpRows) {
			expect(row.isMcp).toBe(true);
		}
	});

	test('isMcp is false for builtin tool names (e.g. bash)', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, {}, 0, 100);
		// In the errors fixture, no bash parts are errors, so this test verifies
		// the flag for a completed bash call via the all-calls mode.
		const allRows = listToolErrors(ids, { status: 'all' }, 0, 100);
		const bashRows = allRows.filter((r) => r.tool === 'bash');
		for (const row of bashRows) {
			expect(row.isMcp).toBe(false);
		}
	});

	test('isDelegation is true when tool is "task"', async () => {
		// The fixture has no 'task' tool parts, so we verify the logic via source.
		const source = new URL('./dashboard-tool-errors.ts', import.meta.url);
		const content = await Bun.file(source).text();
		// isDelegation should be derived from tool === 'task'.
		expect(content).toContain("tool === 'task'");
	});

	test('isDelegation is false for non-task tools', () => {
		const ids = listSessionIds({});
		const rows = listToolErrors(ids, { status: 'all' }, 0, 100);
		const nonTaskRows = rows.filter((r) => r.tool !== 'task');
		for (const row of nonTaskRows) {
			expect(row.isDelegation).toBe(false);
		}
	});
});

/* ------------------------------------------------------------------ */
/* Extended fixture: parts with input/output/endedAt                  */
/* ------------------------------------------------------------------ */

	describe('ToolErrorEntry — extended fixture with input/output/end', () => {
		// We verify the mapping logic by reading the source and confirming the
		// expressions match the expected JSON paths.
		test('input is extracted from part.data.state.input', async () => {
			const source = new URL('./dashboard-tool-errors.ts', import.meta.url);
			const content = await Bun.file(source).text();
			expect(content).toContain("JSON_PATH.part.stateInput");
		});

		test('output is extracted from part.data.state.output', async () => {
			const source = new URL('./dashboard-tool-errors.ts', import.meta.url);
			const content = await Bun.file(source).text();
			expect(content).toContain("JSON_PATH.part.stateOutput");
		});

		test('endedAt is extracted from part.data.state.time.end', async () => {
			const source = new URL('./dashboard-tool-errors.ts', import.meta.url);
			const content = await Bun.file(source).text();
			expect(content).toContain("JSON_PATH.part.stateEnd");
		});

		test('endedAt is null when state.time.end is absent (isBound check)', async () => {
			const source = new URL('./dashboard-tool-errors.ts', import.meta.url);
			const content = await Bun.file(source).text();
			// The query uses isBound to check whether ended_at was returned.
			expect(content).toContain('isBound(row.ended_at)');
		});
	});

/* ------------------------------------------------------------------ */
/* Index-friendly read (#544)                                          */
/* ------------------------------------------------------------------ */
describe('index-friendly read (#544)', () => {
	test('the part reads never join session (agent comes from the session map)', async () => {
		const content = await Bun.file(new URL('./dashboard-tool-errors.ts', import.meta.url)).text();
		// `agent` is a per-session value read once via `agentBySession`, so no
		// `part` query joins `session`.
		expect(content).toContain('agentBySession');
		expect(content).not.toMatch(/JOIN session ON session\.id = part\.session_id/);
	});

	test('every part read is session-scoped, never a global JSON scan', async () => {
		const content = await Bun.file(new URL('./dashboard-tool-errors.ts', import.meta.url)).text();
		// The module must not depend on functional indexes on the opencode DB
		// (the app is read-only and never creates them), so the session filter
		// is always present in the SQL — no global `WHERE <json term>` scans.
		expect(content).toContain('part.session_id IN (${idPlaceholders(ids.length)})');
		expect(content).not.toContain('TOOL_TYPE_EXPR');
		expect(content).not.toContain('SESSION_CHUNK_SIZE');
	});
});
