/**
 * Dashboard-tools service regression suite (task #519).
 *
 * Covers the service-level both-off short-circuit of {@link getTopTools}: when
 * both `basic` and `mcp` are false, the service returns `{ tools: [], capped: false }`
 * without ever opening the database (no `listSessionIds`, no `part` scan).
 *
 * Runs in an isolated child process so it can install a
 * `mock.module('$lib/server/db', …)` without leaking across the broader test suite.
 * The live opencode DB is never opened or written.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T = 1_700_000_000_000;

function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-dashboard-tools-'));

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
	mock.restore();
});

/* ------------------------------------------------------------------ */
/* Service-level: both-off short-circuit                              */
/* ------------------------------------------------------------------ */

describe('getTopTools — both-off short-circuit', () => {
	// Re-import the module with a mocked getDb each time so the mock is fresh.
	async function loadService() {
		// Create a throwaway DB that is intentionally unusable (no schema).
		const badPath = join(tempDir, 'bad.db');
		{
			const db = new Database(badPath);
			db.close();
		}
		// mock.module prevents ANY db handle from being opened — the short-circuit
		// must return before getDb() is ever called.
		mock.module('$lib/server/db', () => ({
			getDb: () => {
				throw new Error('getDb must not be called when both kinds are off');
			},
			resetDbConnection: () => undefined,
			healthCheck: () => ({ ok: true, dbPath: badPath, sessions: 0 }),
			resolveDbPath: () => badPath
		}));
		return (await import(spec('../../../lib/server/services/dashboard-tools.ts'))) as typeof import('../../../lib/server/services/dashboard-tools');
	}

	test('both kinds off returns { tools: [], capped: false } without touching the DB', async () => {
		const { getTopTools } = await loadService();
		// Must not throw — the short-circuit happens before any DB read.
		const result = getTopTools({ period: 'all', scope: null }, T, { basic: false, mcp: false });
		expect(result).toEqual({ tools: [], capped: false });
	});

	test('both kinds off does not resolve session ids', async () => {
		const { getTopTools } = await loadService();
		// Even with an unusable DB handle, the call must succeed because no
		// session resolution or part scan is attempted.
		const result = getTopTools({ period: 'all', scope: null }, T, { basic: false, mcp: false });
		expect(result.tools).toHaveLength(0);
		expect(result.capped).toBe(false);
	});
});
