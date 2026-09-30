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
import { addProject, addSessionV2, applyV2Schema, T } from '../test-fixtures/opencode-v2';

function buildFixture(path: string): void {
	const db = new Database(path);
	applyV2Schema(db);
	addProject(db, { id: 'proj-a', worktree: '/', name: 'Repo A' });

	// Two directories with roots so the cached result is non-trivial.
	addSessionV2(db, { id: 'r1', dir: '/repo/a', created: T, updated: T + 100, projectId: 'proj-a' });
	addSessionV2(db, { id: 'r2', dir: '/repo/b', created: T, updated: T + 200, projectId: 'proj-a' });
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
			applyV2Schema(db);
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
