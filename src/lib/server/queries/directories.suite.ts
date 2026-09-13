/**
 * U2 sidebar directories suite (task #213/#239): `listDirectories()` + `GET
 * /api/directories` against a real fixture SQLite DB.
 *
 * This file intentionally has NO `.test` suffix. It opens a real fixture DB
 * through `$lib/server/db`, and `health.test.ts` installs a process-wide
 * `mock.module('$lib/server/db', ...)` that bun cannot undo, so the wrapper
 * `directories.test.ts` spawns it in an isolated child `bun test` process
 * (pattern from `data-layer.suite.ts` / `search.suite.ts`).
 *
 * The fixture is crafted so a wrong implementation fails in both directions:
 * a child session with the newest `time_updated` (T+9000) must neither be
 * counted nor move `/repo/a`'s `updatedAt`; a blank/NULL directory and a
 * child-only directory must be dropped; and `/repo/a` ties `/repo/c` on
 * `updatedAt` so the `directory ASC` tie-break is observable.
 *
 * Task #239 adds a `project` table plus `session.project_id`: the probe
 * (`hasProjectLink`) finds both, triggers the LEFT JOIN, and every directory
 * row now carries a `projectName`. `/repo/a` maps to a named project;
 * `/repo/c` has no project link so `projectName` stays `null`.
 *
 * The live opencode DB is never opened or written.
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
	CREATE TABLE project (
		id TEXT PRIMARY KEY, name TEXT
	);
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

/**
 * `/repo/a` = 2 roots (newest T+500) + a child with the newest update T+9000;
 * `/repo/c` = 1 root at T+500 (ties `/repo/a`); `/repo/b` = 1 root at T+300;
 * a blank dir, a NULL dir and a child-only dir must all be excluded.
 *
 * `/repo/a` links to project "Repo A"; `/repo/c` has no project linkage so
 * `projectName` stays null.
 */
function buildFixture(path: string): void {
	const db = new Database(path);
	db.exec(SCHEMA);

	// Insert a named project so `/repo/a` gets a non-null projectName.
	db.prepare(`INSERT INTO project (id, name) VALUES ('proj-a', 'Repo A')`).run();
	// `/repo/b` and `/repo/c` have no project row, so their projectName is null.

	const ins = db.prepare(
		`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
			time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
			tokens_cache_read, tokens_cache_write, model, project_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const add = (
		id: string,
		parentId: string | null,
		directory: string | null,
		updated: number,
		projectId: string | null = null
	) =>
		ins.run(
			id,
			parentId,
			directory,
			id,
			'build',
			T,
			updated,
			null,
			0,
			0,
			0,
			0,
			0,
			0,
			null,
			projectId
		);

	// /repo/c is inserted BEFORE /repo/a and ties it on updatedAt (T+500), but
	// sorts after it alphabetically; a missing `directory ASC` tie-break is thus
	// observable rather than accidentally matching the insertion order.
	add('rootC1', null, '/repo/c', T + 500, null);

	// /repo/a: two roots, and a child whose update is newer than both. Links to proj-a.
	add('rootA1', null, '/repo/a', T + 100, 'proj-a');
	add('rootA2', null, '/repo/a', T + 500, 'proj-a');
	add('childA', 'rootA1', '/repo/a', T + 9_000, 'proj-a');

	// /repo/b: strictly older, no project.
	add('rootB1', null, '/repo/b', T + 300, null);

	// Excluded: blank directory, NULL directory, and a directory with no roots.
	add('rootBlank', null, '', T + 7_000, null);
	add('rootNull', null, null, T + 8_000, null);
	add('orphanChild', 'rootC1', '/repo/childonly', T + 6_000, null);

	db.close();
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-u2-directories-'));
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
const listRoute = (await import(spec('../../../routes/api/directories/+server.ts'))) as {
	GET: (event?: unknown) => Response;
};
const { getDb } = (await import(spec('../db.ts'))) as {
	getDb: () => {
		query: (sql: string) => { get: () => unknown; all: () => unknown[] };
	};
};

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe('listDirectories() — root-only grouping, count, max updatedAt, order', () => {
	test('groups root sessions by directory, newest activity first, directory ASC on a tie', () => {
		expect(listDirectories()).toEqual([
			{ directory: '/repo/a', projectName: 'Repo A', sessionCount: 2, updatedAt: T + 500 },
			// Same updatedAt as /repo/a: the `directory ASC` tie-break puts /c last.
			// /repo/c has no project row so projectName is null.
			{ directory: '/repo/c', projectName: null, sessionCount: 1, updatedAt: T + 500 },
			{ directory: '/repo/b', projectName: null, sessionCount: 1, updatedAt: T + 300 }
		]);
	});

	test('updatedAt is the max of the roots only (a newer child never moves it)', () => {
		const a = listDirectories().find((row) => row.directory === '/repo/a');
		// childA (T+9000) is the newest session in /repo/a but is not a root:
		// both the count (2, not 3) and updatedAt (T+500, not T+9000) ignore it.
		expect(a).toEqual({
			directory: '/repo/a',
			projectName: 'Repo A',
			sessionCount: 2,
			updatedAt: T + 500
		});
	});

	test('excludes child-only directories, blank directories and NULL directories', () => {
		const dirs = listDirectories().map((row) => row.directory);
		expect(dirs).not.toContain('/repo/childonly');
		expect(dirs).not.toContain('');
		expect(dirs).toHaveLength(3);
		// A child-only directory has updatedAt T+6000 and blank/nul T+7000/T+8000:
		// if any leaked it would sort ahead of every included directory.
		expect(dirs).toEqual(['/repo/a', '/repo/c', '/repo/b']);
	});

	test('performs no writes and keeps the connection query_only', () => {
		const db = getDb();
		const count = (): number =>
			(db.query('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n;
		const before = count();
		listDirectories();
		expect(count()).toBe(before);
		expect(db.query('PRAGMA query_only').get()).toEqual({ query_only: 1 });
	});
});

describe('listDirectories() — projectName coverage (task #239)', () => {
	test('a directory linked to a named project renders its name', () => {
		const a = listDirectories().find((row) => row.directory === '/repo/a');
		expect(a?.projectName).toBe('Repo A');
	});

	test('a directory with no project linkage gets null projectName', () => {
		const c = listDirectories().find((row) => row.directory === '/repo/c');
		expect(c?.projectName).toBeNull();
		const b = listDirectories().find((row) => row.directory === '/repo/b');
		expect(b?.projectName).toBeNull();
	});

	test('every result row carries the projectName key (Object.keys contract)', () => {
		const rows = listDirectories();
		expect(rows.length).toBe(3);
		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual([
				'directory',
				'projectName',
				'sessionCount',
				'updatedAt'
			]);
		}
	});
});

describe('GET /api/directories — route contract', () => {
	test('returns 200 with the DirectorySummary[] JSON payload', async () => {
		const response = listRoute.GET();
		expect(response.status).toBe(200);
		const rows = (await response.json()) as Array<Record<string, unknown>>;
		expect(Array.isArray(rows)).toBe(true);
		expect(rows).toHaveLength(3);
		expect(Object.keys(rows[0]).sort()).toEqual([
			'directory',
			'projectName',
			'sessionCount',
			'updatedAt'
		]);
		expect(rows).toEqual(listDirectories());
		// Newest activity first, same as the query layer.
		expect(rows.map((row) => row.directory)).toEqual(['/repo/a', '/repo/c', '/repo/b']);
	});
});
