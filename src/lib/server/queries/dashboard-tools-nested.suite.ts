/**
 * Dashboard top-tools nested-call regression suite (ADR D-5, tasks #1500/#1501).
 *
 * Covers the SQL-side nested expansion of `aggregateToolUsage` and the
 * service-level kind selection of `getTopTools`: an `execute` item's nested
 * Code Mode calls must surface in the aggregates, the `execute` wrapper itself
 * must be counted exactly once (no double counting), and the basic/mcp kind
 * filter must classify nested names by the same rule as top-level ones
 * (dot-namespaced = MCP, `search`/`fetch` = basic).
 *
 * This file intentionally has NO `.test` suffix: `health.test.ts` installs a
 * process-wide `mock.module('$lib/server/db', …)` that bun cannot undo, so any
 * suite that exercises the real db module must run in an isolated child
 * process; the wrapper `dashboard-tools-nested.test.ts` spawns `bun test` on
 * this file and asserts `0 fail` (pattern from `m4a-tracker.test.ts`).
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
 * One session whose only assistant message carries an `execute` item with
 * five nested Code Mode calls (two dot-namespaced MCP, one errored MCP, two
 * Code Mode built-ins) plus one plain top-level `bash` call.
 */
function buildFixture(path: string): void {
	const db = new Database(path);
	applyV2Schema(db);
	db.prepare("INSERT INTO project (id, name, worktree, time_created, time_updated, time_active, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
		'proj-a', 'Proj A', '/repo/nt', T, T, 0, '[]'
	);

	addSessionV2(db, { id: 's-nested', dir: '/repo/nt', title: 'Nested', agent: 'build', created: T, updated: T + 1_000, cost: 0, tokens: { input: 0, output: 0, reasoning: 0 }, model: MODEL });
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
					{ tool: 'synaptomind.memory_recall', status: 'completed', input: { query: 'b' } },
					{ tool: 'ziptask.claim_task', status: 'error', input: { task_id: 1497 } },
					{ tool: 'search', status: 'completed', input: { query: 'c' } },
					{ tool: 'fetch', status: 'completed', input: { url: 'https://example.test' } }
				]
			}),
			toolItem('bash', { id: 'c-bash', status: 'completed', input: { command: 'ls' }, text: 'ok', created: T + 100, ran: T + 100, completed: T + 110 })
		]
	});

	db.close();
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-dashboard-tools-nested-'));
const DB_PATH = join(tempDir, 'fixture.db');
buildFixture(DB_PATH);
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const { aggregateToolUsage, DEFAULT_TOP_N } = (await import(spec('./dashboard.ts'))) as typeof import('../queries/dashboard');
const { getTopTools } = (await import(spec('../services/dashboard-tools.ts'))) as typeof import('../services/dashboard-tools');
import type { ToolKindSelection } from '../queries/dashboard-tools';

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

/** name -> record, for count/error assertions. */
function byName(ids: string[], kinds?: ToolKindSelection): Map<string, { count: number; errors: number }> {
	const rows = aggregateToolUsage(ids, DEFAULT_TOP_N, kinds);
	return new Map(rows.map((row) => [row.name, { count: row.count, errors: row.errors }]));
}

/* ------------------------------------------------------------------ */
/* Both kinds on: the wrapper is counted once, nested calls alongside  */
/* ------------------------------------------------------------------ */

describe('aggregateToolUsage — nested calls (both kinds on)', () => {
	test('the execute wrapper is counted exactly once, nested calls as separate rows', () => {
		const tools = byName(['s-nested']);
		// 1 bash + 1 execute + 5 nested = 7 rows total.
		let total = 0;
		for (const { count } of tools.values()) total += count;
		expect(total).toBe(7);
		expect(tools.get('execute')).toEqual({ count: 1, errors: 0 });
		expect(tools.get('bash')).toEqual({ count: 1, errors: 0 });
	});

	test('nested dot-namespaced calls aggregate by tool name with their errors', () => {
		const tools = byName(['s-nested']);
		expect(tools.get('synaptomind.memory_recall')).toEqual({ count: 2, errors: 0 });
		expect(tools.get('ziptask.claim_task')).toEqual({ count: 1, errors: 1 });
	});

	test('nested Code Mode built-ins aggregate as basic tools', () => {
		const tools = byName(['s-nested']);
		expect(tools.get('search')).toEqual({ count: 1, errors: 0 });
		expect(tools.get('fetch')).toEqual({ count: 1, errors: 0 });
	});
});

/* ------------------------------------------------------------------ */
/* Kind selection: mcp-only / basic-only classify nested names too     */
/* ------------------------------------------------------------------ */

describe('aggregateToolUsage — kind selection with nested calls', () => {
	test('mcp-only returns the nested MCP calls, not the wrapper or the built-ins', () => {
		const tools = byName(['s-nested'], { basic: false, mcp: true });
		expect([...tools.keys()].sort()).toEqual(['synaptomind.memory_recall', 'ziptask.claim_task']);
		expect(tools.get('synaptomind.memory_recall')).toEqual({ count: 2, errors: 0 });
		expect(tools.get('ziptask.claim_task')).toEqual({ count: 1, errors: 1 });
	});

	test('basic-only returns execute + the nested search/fetch, not the nested MCP calls', () => {
		const tools = byName(['s-nested'], { basic: true, mcp: false });
		expect([...tools.keys()].sort()).toEqual(['bash', 'execute', 'fetch', 'search']);
		expect(tools.get('execute')).toEqual({ count: 1, errors: 0 });
		expect(tools.get('search')).toEqual({ count: 1, errors: 0 });
		expect(tools.get('fetch')).toEqual({ count: 1, errors: 0 });
	});

	test('both-off returns no rows at all', () => {
		expect(aggregateToolUsage(['s-nested'], DEFAULT_TOP_N, { basic: false, mcp: false })).toEqual([]);
	});
});

/* ------------------------------------------------------------------ */
/* Service level: getTopTools kind selection                           */
/* ------------------------------------------------------------------ */

describe('getTopTools — kind selection with nested calls', () => {
	test('mcp-only settings return the nested MCP calls', () => {
		const { tools } = getTopTools({ period: 'all', scope: null }, T, { basic: false, mcp: true });
		expect(tools.map((entry) => entry.name).sort()).toEqual(['synaptomind.memory_recall', 'ziptask.claim_task']);
		const recall = tools.find((entry) => entry.name === 'synaptomind.memory_recall');
		expect(recall?.count).toBe(2);
		expect(recall?.errors).toBe(0);
		const claim = tools.find((entry) => entry.name === 'ziptask.claim_task');
		expect(claim?.count).toBe(1);
		expect(claim?.errors).toBe(1);
	});

	test('basic-only settings return execute + search/fetch + bash', () => {
		const { tools } = getTopTools({ period: 'all', scope: null }, T, { basic: true, mcp: false });
		expect(tools.map((entry) => entry.name).sort()).toEqual(['bash', 'execute', 'fetch', 'search']);
		const execute = tools.find((entry) => entry.name === 'execute');
		expect(execute?.count).toBe(1);
	});

	test('both-off settings short-circuit to an empty payload', () => {
		const result = getTopTools({ period: 'all', scope: null }, T, { basic: false, mcp: false });
		expect(result).toEqual({ tools: [], capped: false });
	});
});
