/**
 * Tool-errors nested-call regression suite (ADR D-5, tasks #1500/#1501).
 *
 * Covers the SQL-side nested expansion of `listToolErrors`/`countToolErrors`:
 * nested Code Mode calls inside an `execute` item must appear in both the
 * `errors` mode (unified failure definition `status IN ('error','failed')`)
 * and the `all` mode, with the nested entry fields the SQL shape can carry
 * (NULL call id, no error text, no end time), and the `execute` wrapper itself
 * must be counted exactly once (no double counting).
 *
 * This file intentionally has NO `.test` suffix: `health.test.ts` installs a
 * process-wide `mock.module('$lib/server/db', …)` that bun cannot undo, so any
 * suite that exercises the real db module must run in an isolated child
 * process; the wrapper `dashboard-tool-errors-nested.test.ts` spawns `bun test`
 * on this file and asserts `0 fail` (pattern from `m4a-tracker.test.ts`).
 *
 * The live opencode DB is never opened or written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	applyV2Schema,
	addSessionV2,
	addUserMessage,
	addAssistantMessage,
	executeItem,
	toolItem,
	T
} from '../test-fixtures/opencode-v2';

const MODEL = { id: 'gpt-5', providerID: 'anthropic' };

/**
 * One session: an `execute` item with three nested calls (one completed MCP,
 * one ERRORED MCP, one completed Code Mode built-in `search`) plus one plain
 * top-level `bash` call and one plain-JS `execute` item without nested calls.
 */
function buildFixture(path: string): void {
	const db = new Database(path);
	applyV2Schema(db);
	db.prepare("INSERT INTO project (id, name, worktree, time_created, time_updated, time_active, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
		'proj-a', 'Proj A', '/repo/ne', T, T, 0, '[]'
	);

	addSessionV2(db, { id: 's-nested', dir: '/repo/ne', title: 'Nested', agent: 'build', created: T, updated: T + 1_000, cost: 0, tokens: { input: 0, output: 0, reasoning: 0 }, model: MODEL });
	addUserMessage(db, { id: 'u1', sessionId: 's-nested', seq: 1, created: T, text: 'prompt' });
	addAssistantMessage(db, {
		id: 'm1', sessionId: 's-nested', seq: 2, created: T, completed: T + 1_000,
		agent: 'build', model: MODEL, cost: 0, tokens: { input: 0, output: 0, reasoning: 0 },
		finish: 'tool-calls',
		content: [
			executeItem({
				id: 'c-exec', status: 'completed', created: T + 10, ran: T + 10, completed: T + 90,
				toolCalls: [
					{ tool: 'synaptomind.memory_recall', status: 'completed', input: { query: 'a' } },
					{ tool: 'ziptask.get_task', status: 'error', input: { task_id: 1501 } },
					{ tool: 'search', status: 'completed', input: { query: 'b' } }
				]
			}),
			executeItem({ id: 'c-exec-plain', status: 'completed', created: T + 95, ran: T + 95, completed: T + 99 }),
			toolItem('bash', { id: 'c-bash', status: 'completed', input: { command: 'ls' }, text: 'ok', created: T + 100, ran: T + 100, completed: T + 110 })
		]
	});

	db.close();
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-tool-errors-nested-'));
const DB_PATH = join(tempDir, 'fixture.db');
buildFixture(DB_PATH);
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const {
	listToolErrors,
	countToolErrors
} = (await import(spec('./dashboard-tool-errors.ts'))) as typeof import('../queries/dashboard-tool-errors');
const { aggregateToolUsage } = (await import(spec('./dashboard.ts'))) as typeof import('../queries/dashboard');

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

const IDS = ['s-nested'];

/* ------------------------------------------------------------------ */
/* errors mode: the unified failure definition applies to nested calls */
/* ------------------------------------------------------------------ */

describe('countToolErrors — nested calls in errors mode', () => {
	test('counts only the errored nested call; completed nested and top-level calls are excluded', () => {
		// ziptask.get_task (error) is the only failure; synaptomind.memory_recall
		// and search are completed, bash and both execute wrappers are completed.
		expect(countToolErrors(IDS, {})).toBe(1);
	});

	test('the errored nested call carries the SQL-shape fields', () => {
		const rows = listToolErrors(IDS, {}, 0, 100);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.tool).toBe('ziptask.get_task');
		expect(row.status).toBe('error');
		expect(row.isMcp).toBe(true);
		expect(row.isDelegation).toBe(false);
		// Nested entries carry no provider call id, error text, output or end time.
		expect(row.id).toBe('');
		expect(row.error).toBe('');
		expect(row.output).toBeNull();
		expect(row.endedAt).toBeNull();
		// The input object serialises to raw JSON text.
		expect(row.input).toBe('{"task_id":1501}');
		expect(row.sessionId).toBe('s-nested');
		expect(row.agent).toBe('build');
	});
});

/* ------------------------------------------------------------------ */
/* all mode: every nested call appears, the wrapper exactly once       */
/* ------------------------------------------------------------------ */

describe('countToolErrors/listToolErrors — nested calls in all mode', () => {
	test('all mode counts the wrapper once plus every nested entry (no double counting)', () => {
		// c-bash + c-exec + 3 nested + c-exec-plain = 6 rows total; the two
		// execute wrappers each count once and never merge with their nested calls.
		expect(countToolErrors(IDS, { status: 'all' })).toBe(6);
	});

	test('all mode lists every call with its nested names', () => {
		const rows = listToolErrors(IDS, { status: 'all' }, 0, 100);
		expect(rows).toHaveLength(6);
		const byTool = new Map(rows.map((row) => [row.tool, row]));
		expect(byTool.get('bash')).toBeDefined();
		expect(byTool.get('synaptomind.memory_recall')).toBeDefined();
		expect(byTool.get('ziptask.get_task')).toBeDefined();
		expect(byTool.get('search')).toBeDefined();
		// Each execute wrapper is counted once (two items -> two rows), never
		// once per nested call.
		expect(rows.filter((row) => row.tool === 'execute')).toHaveLength(2);
	});

	test('all mode keeps the errored nested call among the completed ones', () => {
		const rows = listToolErrors(IDS, { status: 'all' }, 0, 100);
		const errored = rows.filter((row) => row.status === 'error');
		expect(errored.map((row) => row.tool)).toEqual(['ziptask.get_task']);
	});

	test('paging covers the nested rows', () => {
		const full = listToolErrors(IDS, { status: 'all' }, 0, 100);
		const page = listToolErrors(IDS, { status: 'all' }, 1, 2);
		expect(page).toHaveLength(2);
		expect(page.map((row) => row.id)).toEqual(full.slice(1, 3).map((row) => row.id));
	});
});

/* ------------------------------------------------------------------ */
/* Tool/agent/search filters reach the nested branch                  */
/* ------------------------------------------------------------------ */

describe('filters — nested calls', () => {
	test('tool filter matches a nested call by name', () => {
		const rows = listToolErrors(IDS, { status: 'all', tool: 'synaptomind.memory_recall' }, 0, 100);
		expect(rows).toHaveLength(1);
		expect(rows[0].tool).toBe('synaptomind.memory_recall');
		expect(countToolErrors(IDS, { status: 'all', tool: 'synaptomind.memory_recall' })).toBe(1);
	});

	test('tool filter on the nested errored call counts it in errors mode', () => {
		expect(countToolErrors(IDS, { tool: 'ziptask.get_task' })).toBe(1);
		expect(countToolErrors(IDS, { tool: 'search' })).toBe(0);
	});

	test('agent filter applies to the session owning the nested calls', () => {
		expect(countToolErrors(IDS, { agent: 'build' })).toBe(1);
		expect(countToolErrors(IDS, { agent: 'nobody' })).toBe(0);
	});
});

/* ------------------------------------------------------------------ */
/* Consistency with the top-tools aggregate (errors == errors)          */
/* ------------------------------------------------------------------ */

describe('consistency with top-tools aggregate', () => {
	test('the errors-mode detail total equals the aggregate errors sum', () => {
		const detailTotal = countToolErrors(IDS, {});
		const usage = aggregateToolUsage(IDS);
		const aggregateErrors = usage.reduce((sum, entry) => sum + entry.errors, 0);
		expect(aggregateErrors).toBe(detailTotal);
	});
});
