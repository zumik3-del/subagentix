/**
 * U2 sidebar directories — empty-DB suite (task #213/#239).
 *
 * Isolated child process (see `directories.suite.ts` for the `mock.module`
 * leak rationale). The fixture has the opencode schema plus a `project` table
 * and `session.project_id` column (task #239) but zero sessions, so
 * `listDirectories()` must return `[]` rather than throw or fabricate a group.
 *
 * The live opencode DB is never opened or written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyV2Schema } from '../test-fixtures/opencode-v2';

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-u2-directories-empty-'));
const DB_PATH = join(tempDir, 'empty.db');
const db = new Database(DB_PATH);
applyV2Schema(db);
db.close();
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

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe('listDirectories() — empty DB', () => {
	test('the fixture really exists but has no sessions', () => {
		expect(existsSync(DB_PATH)).toBe(true);
	});

	test('returns [] (no groups, no throw)', () => {
		expect(listDirectories()).toEqual([]);
	});

	test('GET /api/directories returns a 200 empty JSON array', async () => {
		const response = listRoute.GET();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([]);
	});
});
