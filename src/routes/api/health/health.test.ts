import { afterAll, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `/api/health` contract (task #182, ADR §12 step 2): 200 with
 * `{ ok, dbPath, sessions }` on success and a clear 503 when the DB path is
 * unusable. Never touches the live opencode DB.
 *
 * `db.ts` resolves the effective path per call, and Bun caches modules across
 * test files, so each scenario imports a fresh real `db.ts` instance and points
 * the route's `$lib/server/db` import at it with `mock.module`. That keeps the
 * success and failure fixtures isolated without spawning a second process.
 */

interface HealthSuccess {
	ok: true;
	dbPath: string;
	sessions: number;
}

interface HealthFailure {
	ok: false;
	dbPath: string;
	error: string;
}

interface HealthModule {
	GET: (event: unknown) => Promise<Response>;
}

const tempDirs: string[] = [];
// Bun caches modules by resolved specifier across test files, so the token must
// be globally unique, not just increment within this file.
const bustPrefix = crypto.randomUUID();
let bust = 0;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'subagentix-health-'));
	tempDirs.push(dir);
	return dir;
}

/** Absolute path + unique query: a query on a relative specifier does not bust Bun's module cache. */
function absSpec(relative: string): string {
	const url = new URL(relative, import.meta.url);
	return `${url.pathname}?bust=${bustPrefix}-${++bust}`;
}

/** Import the endpoint with `$lib/server/db` redirected to a fresh real db module. */
async function loadRouteWithDbPath(dbPath: string): Promise<HealthModule> {
	process.env.OPENCODE_DB = dbPath;
	process.env.SETTINGS_FILE = join(tempDir(), 'settings.json');
	const db = (await import(absSpec('../../../lib/server/db.ts'))) as {
		resolveDbPath: () => string;
		healthCheck: () => HealthSuccess;
	};
	// Return a plain object: a module namespace from the factory is not handled correctly.
	mock.module('$lib/server/db', () => ({
		resolveDbPath: db.resolveDbPath,
		healthCheck: db.healthCheck
	}));
	return (await import(absSpec('./+server.ts'))) as HealthModule;
}

afterAll(() => {
	mock.restore();
	delete process.env.OPENCODE_DB;
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test('GET /api/health returns 200 with { ok, dbPath, sessions }', async () => {
	const dbPath = join(tempDir(), 'fixture.db');
	const writer = new Database(dbPath);
	writer.exec('CREATE TABLE session (id TEXT PRIMARY KEY);');
	const insert = writer.prepare('INSERT INTO session (id) VALUES (?)');
	for (let i = 0; i < 4; i++) insert.run(`session-${i}`);
	writer.close();

	const { GET } = await loadRouteWithDbPath(dbPath);
	const response = await GET({});
	expect(response.status).toBe(200);

	const body = (await response.json()) as HealthSuccess;
	expect(body).toEqual({ ok: true, dbPath, sessions: 4 });
});

test('GET /api/health returns 503 when the DB path is absent', async () => {
	const dbPath = join(tempDir(), 'missing.db');

	const { GET } = await loadRouteWithDbPath(dbPath);
	const response = await GET({});
	expect(response.status).toBe(503);

	const body = (await response.json()) as HealthFailure;
	expect(body.ok).toBe(false);
	expect(body.dbPath).toBe(dbPath);
	expect(typeof body.error).toBe('string');
	expect(body.error).toContain('not found');
});
