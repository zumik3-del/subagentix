/**
 * Regression test for task #358 / issue #4: `projectLink` schema probe must
 * be invalidated when the effective opencode DB path changes.
 *
 * Before the fix, `projectLink` was a process-global boolean — the first DB
 * probe locked the join decision for the lifetime of the process, so switching
 * `OPENCODE_DB` to a schema without the `project` table still triggered the
 * LEFT JOIN and threw (or returned stale results). After the fix the probe is
 * keyed on the live `Database` handle returned by `getDb()`, so a path change
 * (which drops and reopens the handle) causes a re-probe.
 *
 * This suite intentionally has NO `.test` suffix and runs in an isolated child
 * `bun test` process to avoid `mock.module('$lib/server/db')` leakage from
 * `health.test.ts`. The wrapper `project-link-probe.test.ts` spawns it.
 *
 * Two throwaway fixtures live under the OS temp dir; the live opencode DB is
 * never opened or written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T = 1_700_000_000_000;

/**
 * Schema WITH project linkage (`project` table + `session.project_id`).
 */
const SCHEMA_LINKED = `
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

/**
 * Schema WITHOUT project linkage (no `project` table, no `session.project_id`).
 */
const SCHEMA_UNLINKED = `
	CREATE TABLE session (
		id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, agent TEXT,
		time_created INTEGER, time_updated INTEGER, time_archived INTEGER, cost REAL,
		tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
		tokens_cache_read INTEGER, tokens_cache_write INTEGER, model TEXT
	);
	CREATE INDEX session_parent_idx ON session(parent_id);
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

/** Insert two root sessions with non-blank directories into the given DB. */
function seedSessions(db: Database, schema: string): void {
	if (schema === SCHEMA_LINKED) {
		const ins = db.prepare(
			`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
				time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
				tokens_cache_read, tokens_cache_write, model, project_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		ins.run(
			'r1', null, '/repo/a', 'Root a', 'build', T, T + 100, null, 0, 0, 0, 0, 0, 0, null,
			'proj-a'
		);
		ins.run(
			'r2', null, '/repo/b', 'Root b', 'build', T, T + 200, null, 0, 0, 0, 0, 0, 0, null,
			null
		);
	} else {
		const ins = db.prepare(
			`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
				time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
				tokens_cache_read, tokens_cache_write, model)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		ins.run(
			'r1', null, '/repo/a', 'Root a', 'build', T, T + 100, null, 0, 0, 0, 0, 0, 0, null
		);
		ins.run(
			'r2', null, '/repo/b', 'Root b', 'build', T, T + 200, null, 0, 0, 0, 0, 0, 0, null
		);
	}
}

/** Build a fixture at `path` with the given schema and seed two root sessions. */
function buildFixture(path: string, schema: string): void {
	const db = new Database(path);
	db.exec(schema);
	seedSessions(db, schema);
	if (schema === SCHEMA_LINKED) {
		db.prepare("INSERT INTO project (id, name) VALUES ('proj-a', 'Linked Project')").run();
	}
	db.close();
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-projectlink-'));
const LINKED_PATH = join(tempDir, 'linked.db');
const UNLINKED_PATH = join(tempDir, 'unlinked.db');
buildFixture(LINKED_PATH, SCHEMA_LINKED);
buildFixture(UNLINKED_PATH, SCHEMA_UNLINKED);

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

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe('projectLink probe invalidation on dbPath switch (task #358)', () => {
	test('linked → unlinked: projectName drops to null after path switch', () => {
		// Phase 1: open the linked fixture. The probe records `projectLink = true`.
		process.env.OPENCODE_DB = LINKED_PATH;
		process.env.SETTINGS_FILE = join(tempDir, 'settings-linked.json');
		const before = listDirectories();
		expect(before.length).toBe(2);
		const aBefore = before.find((r) => r.directory === '/repo/a');
		expect(aBefore?.projectName).toBe('Linked Project');

		// Phase 2: switch to the unlinked fixture. `getDb()` reopens at the new
		// path (new Database instance), so the probe must re-run and discover
		// that the `project` table is absent. If the stale-process cache is
		// still active, the LEFT JOIN fires against a non-existent table and
		// the query throws.
		process.env.OPENCODE_DB = UNLINKED_PATH;
		process.env.SETTINGS_FILE = join(tempDir, 'settings-unlinked.json');
		const after = listDirectories();
		expect(after.length).toBe(2);
		const aAfter = after.find((r) => r.directory === '/repo/a');
		expect(aAfter?.projectName).toBeNull();
		const bAfter = after.find((r) => r.directory === '/repo/b');
		expect(bAfter?.projectName).toBeNull();
	});

	test('unlinked → linked: projectName appears after path switch', () => {
		// Reverse direction: start unlinked, switch to linked.
		process.env.OPENCODE_DB = UNLINKED_PATH;
		process.env.SETTINGS_FILE = join(tempDir, 'settings-rev-unlinked.json');
		const before = listDirectories();
		expect(before.length).toBe(2);
		for (const row of before) {
			expect(row.projectName).toBeNull();
		}

		process.env.OPENCODE_DB = LINKED_PATH;
		process.env.SETTINGS_FILE = join(tempDir, 'settings-rev-linked.json');
		const after = listDirectories();
		expect(after.length).toBe(2);
		const aAfter = after.find((r) => r.directory === '/repo/a');
		expect(aAfter?.projectName).toBe('Linked Project');
		const bAfter = after.find((r) => r.directory === '/repo/b');
		expect(bAfter?.projectName).toBeNull();
	});

	test('switching back to the original path reuses the cached probe result', () => {
		// After the first test above the state is "linked". Switching back to the
		// same linked DB should not re-probe (object identity == cached handle).
		process.env.OPENCODE_DB = LINKED_PATH;
		process.env.SETTINGS_FILE = join(tempDir, 'settings-reuse.json');
		const rows = listDirectories();
		expect(rows.length).toBe(2);
		const a = rows.find((r) => r.directory === '/repo/a');
		expect(a?.projectName).toBe('Linked Project');
	});
});
