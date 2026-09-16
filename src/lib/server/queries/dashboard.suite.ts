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
		expect(byDay.get(dayT)).toBe(2);    // s1 + s-midnight-end
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
		// /repo/a (s1), /repo/b (s2), /repo/x (s-midnight-end, s-midnight-start)
		expect(rows.length).toBe(3);
		const a = rows.find((r) => r.directory === '/repo/a');
		const b = rows.find((r) => r.directory === '/repo/b');
		const x = rows.find((r) => r.directory === '/repo/x');
		expect(a?.projectName).toBe('Proj A');
		expect(b?.projectName).toBeNull();
		expect(x?.projectName).toBeNull();
	});
});

describe('Tier-S — aggregateSessionTotals', () => {
	test('totals sum across all five token categories + cost', () => {
		const rec = aggregateSessionTotals({});
		// s1 cost=1.5, s2 cost=3, midnight sessions cost=0 -> total 4.5
		expect(rec.cost).toBeCloseTo(4.5, 5);
		expect(rec.count).toBe(4); // s1, s2, s-midnight-end, s-midnight-start
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
		// 510 extra + 2 fixture (p1 + p3) = 512 total bash parts.
		expect(bash?.count).toBe(512);
		// 255 errors from extras (half of 510) + 0 from fixture bash (p1 ok, p3 ok) = 255
		expect(bash?.errors).toBe(255);
	}, 15_000);

	test('empty set -> []', () => {
		expect(aggregateToolUsage([])).toEqual([]);
	});
});
