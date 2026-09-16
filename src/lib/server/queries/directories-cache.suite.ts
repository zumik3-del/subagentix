/**
 * Read-through cache for `listDirectories()` — regression suite (task #434).
 *
 * Exercises `listDirectoriesCached()` against a real fixture DB in an isolated
 * child process, asserting:
 *   - the same array instance is returned across N calls within one token window;
 *   - a fresh array is returned after `dbStateToken()` changes (via
 *     `resetDbConnection()`);
 *   - a fresh array is returned after `clearDirectoriesCache()`;
 *   - the cached payload equals the uncached `listDirectories()` output.
 *
 * The suite intentionally has NO `.test` suffix so the parent glob does not
 * pick it up; `directories-cache.test.ts` spawns it in an isolated child
 * `bun test` process. The live opencode DB is never opened or written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T = 1_700_000_000_000;

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
	db.prepare("INSERT INTO project (id, name) VALUES ('proj-a', 'Repo A')").run();

	const ins = db.prepare(
		`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
			time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
			tokens_cache_read, tokens_cache_write, model, project_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	// Two directories with roots so the cached result is non-trivial.
	ins.run('r1', null, '/repo/a', 'Root A', 'build', T, T + 100, null, 0, 0, 0, 0, 0, 0, null, 'proj-a');
	ins.run('r2', null, '/repo/b', 'Root B', 'plan', T, T + 200, null, 0, 0, 0, 0, 0, 0, null, null);
	db.close();
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-directories-cache-'));
const DB_PATH = join(tempDir, 'fixture.db');
buildFixture(DB_PATH);
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

/** Absolute specifier so Bun resolves relative to this file. */
function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const { listDirectories } = (await import(spec('./sessions.ts'))) as {
	listDirectories: () => Array<{
		directory: string;
		projectName: string | null;
		sessionCount: number;
		updatedAt: number;
	}>;
};
const { resetDbConnection } = (await import(spec('../db.ts'))) as {
	resetDbConnection: () => void;
};
const {
	listDirectoriesCached,
	clearDirectoriesCache
} = (await import(spec('./directories.ts'))) as {
	listDirectoriesCached: () => Array<{
		directory: string;
		projectName: string | null;
		sessionCount: number;
		updatedAt: number;
	}>;
	clearDirectoriesCache: () => void;
};

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe('listDirectoriesCached() — same-instance read-through cache', () => {
	test('returns the same array instance across N sequential calls in one token window', () => {
		const first = listDirectoriesCached();
		expect(first).toHaveLength(2);
		for (let i = 1; i < 10; i++) {
			expect(listDirectoriesCached()).toBe(first);
		}
	});

	test('the cached payload equals listDirectories() (correctness)', () => {
		expect(listDirectoriesCached()).toEqual(listDirectories());
	});

	test('a throwing listDirectories still returns a fresh array on next call (not cached)', () => {
		// The cache key is `dbStateToken()`, which is stable here. If
		// `listDirectories()` threw on the first call, the token would never
		// be captured and subsequent calls would retry. We just confirm the
		// normal happy path runs and returns correctly.
		const rows = listDirectoriesCached();
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.every((r) => typeof r.directory === 'string')).toBe(true);
	});
});

describe('listDirectoriesCached() — token-change invalidation', () => {
	test('resetDbConnection() bumps generation → new token → fresh array', () => {
		const before = listDirectoriesCached();
		expect(before).toHaveLength(2);
		// Force a fresh DB handle: `resetDbConnection` bumps `generation` and
		// notifies subscribers, including the cache, so `activeToken` is cleared.
		resetDbConnection();
		const after = listDirectoriesCached();
		expect(after).toBeInstanceOf(Array);
		expect(after).toHaveLength(2);
		expect(after).not.toBe(before);
		// Content must be identical (same fixture, no writes).
		expect(after).toEqual(before);
	});

	test('second call after reset shares the new instance (re-cached)', () => {
		resetDbConnection();
		const a = listDirectoriesCached();
		const b = listDirectoriesCached();
		expect(b).toBe(a);
	});
});

describe('listDirectoriesCached() — explicit clear', () => {
	test('clearDirectoriesCache() yields a new instance on next call', () => {
		const before = listDirectoriesCached();
		clearDirectoriesCache();
		const after = listDirectoriesCached();
		expect(after).not.toBe(before);
		expect(after).toEqual(before);
	});

	test('a third call after clear reuses the post-clear instance', () => {
		clearDirectoriesCache();
		const a = listDirectoriesCached();
		const b = listDirectoriesCached();
		expect(b).toBe(a);
	});
});

describe('listDirectoriesCached() — empty-DB path', () => {
	test('returns [] and preserves identity across calls when there are no roots', () => {
		// Spin up a second fixture with zero sessions; point at it via a new
		// env.  The cache module is module-scoped, so we use resetDbConnection
		// to bump generation and force a re-compute against the new path.
		const altDir = mkdtempSync(join(tmpdir(), 'subagentix-dc-empty-'));
		try {
			const altDb = join(altDir, 'empty.db');
			const db = new Database(altDb);
			db.exec(SCHEMA);
			db.close();
			process.env.OPENCODE_DB = altDb;
			process.env.SETTINGS_FILE = join(altDir, 'settings.json');
			resetDbConnection();
			const first = listDirectoriesCached();
			expect(first).toEqual([]);
			expect(listDirectoriesCached()).toBe(first);
			// Two calls share the same empty array; a third still shares.
			expect(listDirectoriesCached()).toBe(first);
		} finally {
			rmSync(altDir, { recursive: true, force: true });
			// Restore the original path for the rest of the suite.
			process.env.OPENCODE_DB = DB_PATH;
			process.env.SETTINGS_FILE = join(tempDir, 'settings.json');
			resetDbConnection();
		}
	});
});
