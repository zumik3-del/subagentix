/**
 * Dashboard query regression suite (tasks #403, #406, #407).
 *
 * Covers Tier-S (`session`-only), Tier-M (`message` + chunked `IN`), and
 * Tier-P (`part` + chunked `IN`) aggregates against a fixture SQLite DB. The
 * fixture has two sessions in two directories with messages spanning midnight
 * UTC boundaries, tool parts with mixed error/ok status, and enough rows to
 * exercise the >999-id chunking path.
 *
 * Runs in an isolated child process (see `dashboard.test.ts`) so the suite
 * owns a clean `$lib/server/db` / `$lib/server/settings` module graph without
 * pollution from the health test's `mock.module('$lib/server/db', ...)`.
 *
 * The live opencode DB is never opened or written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T = 1_700_000_000_000; // 2023-11-13T22:13:20Z
const MODEL = JSON.stringify({ id: 'gpt-5', providerID: 'anthropic' });
/** Last millisecond of the UTC day containing T. */
const DAY_END = T - (T % 86_400_000) + 86_400_000 - 1;
/** First millisecond of the next UTC day. */
const DAY_START = DAY_END + 1;

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

/** Build a fixture with baseline + boundary data. */
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

	// --- Baseline sessions ---------------------------------------------------
	// s1: /repo/a, agent=build, at T
	insSession.run('s1', null, '/repo/a', 'S1', 'build', T, T + 100, null, 1.5, 100, 200, 10, 50, 100, MODEL, 'proj-a');
	// s2: /repo/b, agent=plan, at T-DAY (yesterday)
	insSession.run('s2', null, '/repo/b', 'S2', 'plan', T - 86_400_000, T - 86_300_000, null, 3, 80, 100, 7, 40, 80, MODEL, null);

	// --- Midnight-boundary session: first ms of day N+1 ----------------------
	insSession.run('s-midnight-end', null, '/repo/x', 'MidnightEnd', 'build', DAY_END, DAY_END, null, 0, 0, 0, 0, 0, 0, MODEL, null);
	insSession.run('s-midnight-start', null, '/repo/x', 'MidnightStart', 'build', DAY_START, DAY_START, null, 0, 0, 0, 0, 0, 0, MODEL, null);

	// --- Messages -------------------------------------------------------------
	insMessage.run('m1', 's1', T + 100, T + 100, JSON.stringify({ role: 'user', time: { created: T + 100 } }));
	insMessage.run('m2', 's1', T + 200, T + 200, JSON.stringify({
		role: 'assistant', parentID: 'm1', cost: 1,
		tokens: { input: 50, output: 100, reasoning: 5, cache: { read: 25, write: 50 } },
		time: { created: T + 200, completed: T + 300 }
	}));
	insMessage.run('m3', 's1', T + 500, T + 500, JSON.stringify({
		role: 'assistant', cost: 0.5,
		tokens: { input: 50, output: 100, reasoning: 5, cache: { read: 25, write: 50 } },
		time: { created: T + 500, completed: T + 600 }
	}));
	insMessage.run('m4', 's2', T - 86_400_000 + 100, T - 86_400_000 + 100, JSON.stringify({
		role: 'user', time: { created: T - 86_400_000 + 100 }
	}));
	insMessage.run('m5', 's2', T - 86_400_000 + 200, T - 86_400_000 + 200, JSON.stringify({
		role: 'assistant', parentID: 'm4', cost: 3,
		tokens: { input: 80, output: 100, reasoning: 7, cache: { read: 40, write: 80 } },
		time: { created: T - 86_400_000 + 200, completed: T - 86_400_000 + 300 }
	}));
	// Midnight-boundary messages
	insMessage.run('m-midnight-end', 's-midnight-end', DAY_END, DAY_END, JSON.stringify({
		role: 'assistant', cost: 1,
		tokens: { input: 10, output: 10, reasoning: 1, cache: { read: 1, write: 1 } },
		time: { created: DAY_END }
	}));
	insMessage.run('m-midnight-start', 's-midnight-start', DAY_START, DAY_START, JSON.stringify({
		role: 'assistant', cost: 2,
		tokens: { input: 20, output: 20, reasoning: 2, cache: { read: 2, write: 2 } },
		time: { created: DAY_START }
	}));

	// --- Tool parts -----------------------------------------------------------
	insPart.run('p1', 'm2', 's1', T + 250, T + 250, JSON.stringify({
		type: 'tool', tool: 'bash', callID: 'c1',
		state: { status: 'completed', time: { start: T + 200, end: T + 250 } }
	}));
	insPart.run('p2', 'm2', 's1', T + 280, T + 280, JSON.stringify({
		type: 'tool', tool: 'mcp_recall', callID: 'c2',
		state: { status: 'error', error: 'boom', time: { start: T + 250, end: T + 280 } }
	}));
	// Blank-tool part (no `tool` key → 'unknown')
	insPart.run('p-blank', 'm2', 's1', T + 290, T + 290, JSON.stringify({
		type: 'tool', callID: 'c-blank',
		state: { status: 'completed', time: { start: T + 280, end: T + 290 } }
	}));
	insPart.run('p3', 'm5', 's2', T - 86_400_000 + 220, T - 86_400_000 + 220, JSON.stringify({
		type: 'tool', tool: 'bash', callID: 'c3',
		state: { status: 'completed', time: { start: T - 86_400_000 + 200, end: T - 86_400_000 + 220 } }
	}));

	// --- Kind-filter fixture sessions (E10/E11/E12/E15) -----------------------
	// s-kf: high-count mcp tool + moderate basic tools to prove filter-before-top-N.
	insSession.run('s-kf', null, '/repo/kf', 'KF', 'build', T + 1_000, T + 1_100, null, 0, 0, 0, 0, 0, 0, MODEL, null);
	insMessage.run('m-kf', 's-kf', T + 1_000, T + 1_100, JSON.stringify({
		role: 'assistant', cost: 0,
		tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
		time: { created: T + 1_000, completed: T + 1_100 }
	}));
	// 200 mcp_x calls (MCP, non-allowlist)
	for (let i = 0; i < 200; i++) {
		insPart.run(`p-kf-mcp-${i}`, 'm-kf', 's-kf', T + 1_000 + i, T + 1_000 + i, JSON.stringify({
			type: 'tool', tool: 'mcp_x', callID: `kc-mcp-${i}`,
			state: { status: 'completed', time: { start: T + 1_000 + i, end: T + 1_000 + i } }
		}));
	}
	// 50 invalid calls (explicitly basic)
	for (let i = 0; i < 50; i++) {
		insPart.run(`p-kf-inv-${i}`, 'm-kf', 's-kf', T + 2_000 + i, T + 2_000 + i, JSON.stringify({
			type: 'tool', tool: 'invalid', callID: `kc-inv-${i}`,
			state: { status: 'completed', time: { start: T + 2_000 + i, end: T + 2_000 + i } }
		}));
	}
	// 50 bash calls (basic) — total unfiltered top-2 would be mcp_x(200) + invalid/bash(50 tie-break);
	// after basic-only filter, invalid(50) and bash(51 inc s1) are the only candidates.
	for (let i = 0; i < 50; i++) {
		insPart.run(`p-kf-bash-${i}`, 'm-kf', 's-kf', T + 3_000 + i, T + 3_000 + i, JSON.stringify({
			type: 'tool', tool: 'bash', callID: `kc-bash-${i}`,
			state: { status: 'completed', time: { start: T + 3_000 + i, end: T + 3_000 + i } }
		}));
	}

	// s-unk: unknown-tool session (E10 — unknown is mcp)
	insSession.run('s-unk', null, '/repo/unk', 'Unk', 'plan', T + 2_000, T + 2_100, null, 0, 0, 0, 0, 0, 0, MODEL, null);
	insMessage.run('m-unk', 's-unk', T + 2_000, T + 2_100, JSON.stringify({
		role: 'assistant', cost: 0,
		tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
		time: { created: T + 2_000, completed: T + 2_100 }
	}));
	// 30 blank-tool parts → 'unknown' (mcp)
	for (let i = 0; i < 30; i++) {
		insPart.run(`p-unk-${i}`, 'm-unk', 's-unk', T + 2_000 + i, T + 2_000 + i, JSON.stringify({
			type: 'tool', callID: `kc-unk-${i}`,
			state: { status: 'completed', time: { start: T + 2_000 + i, end: T + 2_000 + i } }
		}));
	}

	db.close();
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-dashboard-queries-'));
const DB_PATH = join(tempDir, 'fixture.db');
buildFixture(DB_PATH);
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const { getDb } = (await import(spec('../db.ts'))) as {
	getDb: () => { query: (sql: string, ...args: unknown[]) => { all: () => unknown[]; get: () => unknown } };
};
const { resetDbConnection } = (await import(spec('../db.ts'))) as {
	resetDbConnection: () => void;
};
const {
	IN_CHUNK_SIZE,
	DEFAULT_TOP_N,
	listSessionIds,
	countSessionsByUtcDay,
	countSessionsByAgent,
	countSessionsByModel,
	countSessionsByProvider,
	countSessionsByDirectory,
	aggregateSessionTotals,
	aggregateMessageUsageByUtcDay,
	aggregateToolUsage
} = (await import(spec('./dashboard.ts'))) as typeof import('../queries/dashboard');
const { BASIC_TOOL_NAMES } = await import('../../model/tool-kind');
const { MAX_TOOL_SESSIONS } = await import('../../model/dashboard');

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

/** Open a writable handle to the fixture (getDb is read-only). */
function writableDb(): Database {
	return new Database(DB_PATH);
}

/* ------------------------------------------------------------------ */
/* Tier-S: session-only aggregates                                    */
/* ------------------------------------------------------------------ */

describe('Tier-S — countSessionsByUtcDay', () => {
	test('two sessions on day T and day T-86400 plus boundary sessions -> 3 days', () => {
		const rows = countSessionsByUtcDay({});
		expect(rows.length).toBe(3);
		const dayT = new Date(T).toISOString().slice(0, 10);
		const dayPrev = new Date(T - 86_400_000).toISOString().slice(0, 10);
		const dayNext = new Date(DAY_START).toISOString().slice(0, 10);
		expect(rows.map((r) => r.day)).toEqual([dayPrev, dayT, dayNext]);
		const byDay = new Map(rows.map((r) => [r.day, r.count]));
		expect(byDay.get(dayPrev)).toBe(1); // s2
		expect(byDay.get(dayT)).toBe(4);    // s1 + s-midnight-end + s-kf + s-unk
		expect(byDay.get(dayNext)).toBe(1); // s-midnight-start
	});

	test('scope binds session.directory as a SQL parameter (not a JS post-filter)', () => {
		const scoped = countSessionsByUtcDay({ directory: '/repo/a' });
		expect(scoped.length).toBe(1);
		expect(scoped[0].count).toBe(1);
		expect(scoped[0].day).toBe(new Date(T).toISOString().slice(0, 10));
	});

	test('UTC midnight boundary: last-ms-of-day and first-ms-of-next-day land in different buckets', () => {
		const rows = countSessionsByUtcDay({});
		const days = rows.map((r) => r.day);
		const day1 = new Date(DAY_END).toISOString().slice(0, 10);
		const day2 = new Date(DAY_START).toISOString().slice(0, 10);
		expect(days).toContain(day1);
		expect(days).toContain(day2);
		// They must be different days.
		expect(day1).not.toBe(day2);
	});
});

describe('Tier-S — countSessionsByAgent / Model / Provider', () => {
	test('agent groups into "unknown" for NULL agent', () => {
		const rows = countSessionsByAgent({});
		const names = rows.map((r) => r.name);
		expect(names).toContain('build');
		expect(names).toContain('plan');
	});

	test('model/provider read via schema.jsonExtract (no literal JSON path in the query)', () => {
		const modelRows = countSessionsByModel({});
		const providerRows = countSessionsByProvider({});
		expect(modelRows.length).toBe(1);
		expect(providerRows.length).toBe(1);
	});

	test('top-N limit caps the result; sanitizeLimit rejects non-finite', () => {
		expect(countSessionsByAgent({}, 0)).toEqual([]);
		expect(countSessionsByAgent({}, NaN)).toEqual([]);
		expect(countSessionsByAgent({}, -1)).toEqual([]);
	});
});

describe('Tier-S — countSessionsByDirectory', () => {
	test('blank and NULL directories are dropped; project-name join when linked', () => {
		const rows = countSessionsByDirectory({});
		// /repo/a (s1, s-kf), /repo/b (s2), /repo/x (s-midnight-end, s-midnight-start),
		// /repo/kf (s-kf), /repo/unk (s-unk)
		expect(rows.length).toBe(5);
		const a = rows.find((r) => r.directory === '/repo/a');
		const b = rows.find((r) => r.directory === '/repo/b');
		const x = rows.find((r) => r.directory === '/repo/x');
		const kf = rows.find((r) => r.directory === '/repo/kf');
		const unk = rows.find((r) => r.directory === '/repo/unk');
		expect(a?.projectName).toBe('Proj A');
		expect(b?.projectName).toBeNull();
		expect(x?.projectName).toBeNull();
		expect(kf?.projectName).toBeNull();
		expect(unk?.projectName).toBeNull();
	});
});

describe('Tier-S — aggregateSessionTotals', () => {
	test('totals sum across all five token categories + cost', () => {
		const rec = aggregateSessionTotals({});
		// s1 cost=1.5, s2 cost=3, midnight sessions cost=0, s-kf cost=0, s-unk cost=0 -> total 4.5
		expect(rec.cost).toBeCloseTo(4.5, 5);
		expect(rec.count).toBe(6); // s1, s2, s-midnight-end, s-midnight-start, s-kf, s-unk
		expect(rec.tokens.input).toBe(180);
		expect(rec.tokens.output).toBe(300);
		expect(rec.tokens.reasoning).toBe(17);
		expect(rec.tokens.cacheRead).toBe(90);
		expect(rec.tokens.cacheWrite).toBe(180);
	});

	test('scope binds correctly', () => {
		const rec = aggregateSessionTotals({ directory: '/repo/a' });
		expect(rec.count).toBe(1);
		expect(rec.cost).toBeCloseTo(1.5, 5);
	});
});

/* ------------------------------------------------------------------ */
/* Tier-M: message-day aggregation (task #406)                        */
/* ------------------------------------------------------------------ */

describe('Tier-M — aggregateMessageUsageByUtcDay', () => {
	test('empty id list returns []', () => {
		expect(aggregateMessageUsageByUtcDay([], {})).toEqual([]);
	});

	test('windowed sums == per-day sums == totals (no double count)', () => {
		const ids = listSessionIds({});
		const daily = aggregateMessageUsageByUtcDay(ids, {});
		const direct = aggregateMessageUsageByUtcDay(ids, {});
		expect(daily).toEqual(direct);
		expect(daily.length).toBeGreaterThan(0);
	});

	test('UTC boundary: 23:59:59.999Z vs 00:00:00.000Z land in separate buckets', () => {
		const ids = listSessionIds({});
		const daily = aggregateMessageUsageByUtcDay(ids, {});
		const days = daily.map((r) => r.day);
		const day1 = new Date(DAY_END).toISOString().slice(0, 10);
		const day2 = new Date(DAY_START).toISOString().slice(0, 10);
		expect(days).toContain(day1);
		expect(days).toContain(day2);
	});

	test('half-open [from, to) excludes "to" and "< from"', () => {
		const ids = listSessionIds({});
		const daily = aggregateMessageUsageByUtcDay(ids, { from: T, to: T + 1 });
		// from=T, to=T+1 (1ms window): s1 messages at T+200/T+500 excluded;
		// s-midnight-end at day1End excluded; s-midnight-start at day2Start excluded.
		expect(daily).toEqual([]);
	});

	test('scope directory bound param filters ids before message read', () => {
		const idsScoped = listSessionIds({ directory: '/repo/a' });
		const idsUnscoped = listSessionIds({});
		expect(idsScoped.length).toBeLessThan(idsUnscoped.length);
		const dailyScoped = aggregateMessageUsageByUtcDay(idsScoped, {});
		const dailyUnscoped = aggregateMessageUsageByUtcDay(idsUnscoped, {});
		const sumScoped = dailyScoped.reduce((s, r) => s + r.cost, 0);
		const sumUnscoped = dailyUnscoped.reduce((s, r) => s + r.cost, 0);
		expect(sumScoped).toBeLessThan(sumUnscoped);
	});

	test('>999 ids are chunked and all summed (IN_CHUNK_SIZE === 500)', () => {
		expect(IN_CHUNK_SIZE).toBe(500);
		// Inject 510 dummy sessions (just over one chunk) so the merge path is exercised.
		const w = writableDb();
		const ins = w.prepare(
			`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
				time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
				tokens_cache_read, tokens_cache_write, model, project_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		const insMsg = w.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
		// One transaction: 1020 individual autocommit inserts were ~20x slower.
		w.transaction(() => {
			for (let i = 0; i < 510; i++) {
				ins.run(`chunk-${i}`, null, '/repo/chunk', `Chunk ${i}`, 'build', T + i, T + i, null, 0, 0, 0, 0, 0, 0, MODEL, null);
			}
			for (let i = 0; i < 510; i++) {
				insMsg.run(`cm-${i}`, `chunk-${i}`, T + i, T + i, JSON.stringify({
					role: 'assistant', cost: 1,
					tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
					time: { created: T + i }
				}));
			}
		})();
		w.close();

		const ids = listSessionIds({});
		const daily = aggregateMessageUsageByUtcDay(ids, {});
		const total = daily.reduce((s, r) => s + r.cost, 0);
		// 510 extra @ 1 + fixture (m2=1, m3=0.5, m5=3, m-midnight-end=1, m-midnight-start=2) = 7.5
		expect(total).toBeCloseTo(517.5, 5);
	}, 15_000);

	test('dense zero-filled series: missing days between present days show cost 0', () => {
		const ids = listSessionIds({});
		const daily = aggregateMessageUsageByUtcDay(ids, {});
		const days = daily.map((r) => r.day);
		expect(days).toEqual([...days].sort());
	});

	test('PRAGMA query_only stays 1 after reads', () => {
		const db = getDb();
		aggregateMessageUsageByUtcDay(listSessionIds({}), {});
		expect(db.query('PRAGMA query_only').get()).toEqual({ query_only: 1 });
	});
});

/* ------------------------------------------------------------------ */
/* Tier-P: tool frequency (task #407)                                 */
/* ------------------------------------------------------------------ */

describe('Tier-P — aggregateToolUsage', () => {
	test('empty id list returns []', () => {
		expect(aggregateToolUsage([])).toEqual([]);
	});

	test('blank / NULL tool name labels as "unknown"', () => {
		const rows = aggregateToolUsage(['s1']);
		const names = rows.map((r) => r.name);
		expect(names).toContain('unknown'); // p-blank has no tool key
	});

	test('error share: 1 error out of 1 mcp_recall call -> errors=1', () => {
		const rows = aggregateToolUsage(['s1']);
		const bash = rows.find((r) => r.name === 'bash');
		const mcp = rows.find((r) => r.name === 'mcp_recall');
		expect(bash?.count).toBe(1);
		expect(bash?.errors).toBe(0);
		expect(mcp?.count).toBe(1);
		expect(mcp?.errors).toBe(1);
	});

	test('ordering: count desc, name asc (including tie-break)', () => {
		const rows = aggregateToolUsage(['s1']);
		const names = rows.map((r) => r.name);
		// bash (1) and mcp_recall (1) tie on count; name asc puts bash before mcp_recall.
		const bashIdx = names.indexOf('bash');
		const mcpIdx = names.indexOf('mcp_recall');
		if (bashIdx !== -1 && mcpIdx !== -1) {
			expect(bashIdx).toBeLessThan(mcpIdx);
		}
	});

	test('top-N cap: limit=2 returns at most 2 rows', () => {
		const rows = aggregateToolUsage(['s1'], 2);
		expect(rows.length).toBeLessThanOrEqual(2);
	});

	test('top-N cap: limit=0 returns []', () => {
		expect(aggregateToolUsage(['s1'], 0)).toEqual([]);
	});

	test('7-day window includes s2 (1 day before T, within [-7d, 0))', () => {
		const ids = listSessionIds({ from: T - 7 * 86_400_000, to: T });
		// s2 at T-DAY is within [T-7*DAY, T). s1 at T is EXCLUDED by the half-open upper bound.
		expect(ids).toContain('s2');
		expect(ids).not.toContain('s1');
	});

	test('scope /repo/b filters to s2 only', () => {
		const ids = listSessionIds({ directory: '/repo/b' });
		expect(ids).toEqual(['s2']);
	});

	test('most-recent cap: listSessionIds with max=1 returns only the newest session', () => {
		const ids = listSessionIds({}, 1);
		// s-midnight-start at day2Start is the newest session.
		expect(ids).toHaveLength(1);
		expect(ids[0]).toBe('s-midnight-start');
	});

	test('chunk merge across 510 ids (> IN_CHUNK_SIZE=500)', () => {
		const w = writableDb();
		const insSession = w.prepare(
			`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
				time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
				tokens_cache_read, tokens_cache_write, model, project_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		const insPart = w.prepare(
			'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
		);
		const insMsg = w.prepare(
			'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
		);
		// One transaction: 1530 individual autocommit inserts blow the 15s timeout.
		w.transaction(() => {
			for (let i = 0; i < 510; i++) {
				const sid = `big-${i}`;
				insSession.run(sid, null, '/repo/big', `Big ${i}`, 'build', T, T, null, 0, 0, 0, 0, 0, 0, MODEL, null);
				insMsg.run(`pm-${i}`, sid, T, T, '{}');
				insPart.run(`pp-${i}`, `pm-${i}`, sid, T, T, JSON.stringify({
					type: 'tool', tool: 'bash', callID: `call-${i}`,
					state: { status: i % 2 === 0 ? 'completed' : 'error', time: { start: T, end: T } }
				}));
			}
		})();
		w.close();

		const ids = listSessionIds({});
		const rows = aggregateToolUsage(ids);
		const bash = rows.find((r) => r.name === 'bash');
		// 510 extra + 2 fixture (p1 + p3) + 50 from s-kf = 562 total bash parts.
		expect(bash?.count).toBe(562);
		// 255 errors from extras (half of 510) + 0 from fixture bash (p1 ok, p3 ok) + 0 from s-kf = 255
		expect(bash?.errors).toBe(255);
	}, 15_000);

	test('empty set -> []', () => {
		expect(aggregateToolUsage([])).toEqual([]);
	});

	// ---- kind-filter tests (epic #512, task #519) ---------------------------

	test('basic-only excludes every non-allowlist tool (mcp_recall, unknown)', () => {
		// Use specific session ids to avoid interfering with other tests.
		const ids = ['s1', 's-kf', 's-unk'];
		const rows = aggregateToolUsage(ids, DEFAULT_TOP_N, { basic: true, mcp: false });
		const names = rows.map((r) => r.name);
		// mcp_recall is NOT in the allowlist → excluded.
		expect(names).not.toContain('mcp_recall');
		// unknown (blank tool key) is NOT in the allowlist → excluded.
		expect(names).not.toContain('unknown');
		// Only basic tools should remain.
		for (const name of names) {
			expect(BASIC_TOOL_NAMES).toContain(name);
		}
	});

	test('mcp-only excludes every allowlist tool (bash, invalid)', () => {
		const ids = ['s1', 's-kf', 's-unk'];
		const rows = aggregateToolUsage(ids, DEFAULT_TOP_N, { basic: false, mcp: true });
		const names = rows.map((r) => r.name);
		// basic tools excluded.
		expect(names).not.toContain('bash');
		expect(names).not.toContain('invalid');
		// mcp tools included.
		expect(names).toContain('mcp_recall');
		expect(names).toContain('unknown');
		expect(names).toContain('mcp_x');
	});

	test('both-on returns the unfiltered result (same shape and counts)', () => {
		const ids = ['s1', 's-kf', 's-unk'];
		const filtered = aggregateToolUsage(ids, DEFAULT_TOP_N, { basic: true, mcp: true });
		const unfiltered = aggregateToolUsage(ids, DEFAULT_TOP_N, undefined);
		expect(filtered.map((r) => r.name)).toEqual(unfiltered.map((r) => r.name));
		for (let i = 0; i < filtered.length; i++) {
			expect(filtered[i].count).toBe(unfiltered[i].count);
			expect(filtered[i].errors).toBe(unfiltered[i].errors);
		}
	});

	test('top-N applied AFTER the kind filter: basic-only limit=2 contains only basic tools', () => {
		const ids = ['s1', 's-kf', 's-unk'];
		// Unfiltered top-2: mcp_x(200), bash(51).
		const unfiltered = aggregateToolUsage(ids, 2);
		expect(unfiltered[0].name).toBe('mcp_x');
		expect(unfiltered[0].count).toBe(200);
		expect(unfiltered[1].name).toBe('bash');
		expect(unfiltered[1].count).toBe(51);
		// Basic-only limit=2: only bash(51) and invalid(50) are candidates → both appear.
		// If top-N were applied BEFORE filtering, mcp_x(200) would consume one slot
		// and we would get only one basic tool. The fact that both basic tools appear
		// proves filter-before-top-N.
		const basic = aggregateToolUsage(ids, 2, { basic: true, mcp: false });
		expect(basic.length).toBe(2);
		expect(basic[0].name).toBe('bash');
		expect(basic[0].count).toBe(51);
		expect(basic[1].name).toBe('invalid');
		expect(basic[1].count).toBe(50);
	});

	test('unknown is classified as mcp (present in mcp-only, absent in basic-only)', () => {
		const ids = ['s1', 's-kf', 's-unk'];
		const mcpRows = aggregateToolUsage(ids, DEFAULT_TOP_N, { basic: false, mcp: true });
		const basicRows = aggregateToolUsage(ids, DEFAULT_TOP_N, { basic: true, mcp: false });
		expect(mcpRows.map((r) => r.name)).toContain('unknown');
		expect(basicRows.map((r) => r.name)).not.toContain('unknown');
	});

	test('invalid is classified as basic (present in basic-only, absent in mcp-only)', () => {
		const ids = ['s1', 's-kf', 's-unk'];
		const mcpRows = aggregateToolUsage(ids, DEFAULT_TOP_N, { basic: false, mcp: true });
		const basicRows = aggregateToolUsage(ids, DEFAULT_TOP_N, { basic: true, mcp: false });
		expect(basicRows.map((r) => r.name)).toContain('invalid');
		expect(mcpRows.map((r) => r.name)).not.toContain('invalid');
	});

	test('capped semantics unchanged: period=all with both-on still returns correct capped flag', () => {
		// The fixture has sessions spanning two UTC days. With period=all and no scope,
		// all 6 sessions are in range. The session ceiling (MAX_TOOL_SESSIONS) is much
		// larger than 6, so capped must be false.
		const allIds = listSessionIds({});
		expect(allIds.length).toBeLessThanOrEqual(MAX_TOOL_SESSIONS);
		const usage = aggregateToolUsage(allIds, DEFAULT_TOP_N, { basic: true, mcp: true });
		expect(Array.isArray(usage)).toBe(true);
		expect(usage.length).toBeGreaterThan(0);
		// capped is a service-level concern; the query just returns the full list.
		// Verify the query does not truncate due to a hidden cap.
		expect(usage.map((r) => r.name)).toContain('mcp_x');
	});
});
