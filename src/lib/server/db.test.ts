import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * M1 data-access tests (task #182, ADR §4.1).
 *
 * These tests never open the live opencode DB. Every scenario points
 * `OPENCODE_DB` at a throwaway fixture created under the OS temp dir, so a
 * regression cannot mutate `/home/opencode/.local/share/opencode/**`.
 *
 * `db.ts` resolves the effective path per call (file -> `OPENCODE_DB` ->
 * default) and keeps a module-level connection keyed by path, so each scenario
 * gets a fresh module instance through a cache-busting query string on the
 * import URL. `SETTINGS_FILE` points at a non-existent file so the environment
 * stays authoritative.
 */

const DEFAULT_DB_PATH = '/home/opencode/.local/share/opencode/opencode.db';

interface HealthReport {
	ok: true;
	dbPath: string;
	sessions: number;
}

interface DbModule {
	resolveDbPath: () => string;
	getDb: () => Database;
	healthCheck: () => HealthReport;
	resetDbConnection: () => void;
}

const tempDirs: string[] = [];
const originalOpencodeDb = process.env.OPENCODE_DB;
// A real `settings.json` could override `OPENCODE_DB`; isolate the store to a
// path that never exists so the environment stays authoritative in these tests.
process.env.SETTINGS_FILE = join(tmpdir(), `subagentix-db-test-settings-${crypto.randomUUID()}.json`);

// Bun caches modules by resolved specifier across test files, so the token must
// be globally unique, not just increment within this file.
const bustPrefix = crypto.randomUUID();
let bust = 0;

/**
 * Import `src/lib/server/db.ts` as a fresh module instance. Bun caches modules
 * by resolved path, so the specifier is an absolute path plus a unique query
 * string (a query on a relative specifier is ignored and would reuse the cache).
 */
async function freshDbModule(): Promise<DbModule> {
	const url = new URL('./db.ts', import.meta.url);
	return (await import(`${url.pathname}?bust=${bustPrefix}-${++bust}`)) as DbModule;
}

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'subagentix-test-'));
	tempDirs.push(dir);
	return dir;
}

/** Create a rollback-journal fixture with a `session` table holding N rows. */
function createFixtureDb(sessions = 3): string {
	const path = join(tempDir(), 'fixture.db');
	const db = new Database(path);
	db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);');
	const insert = db.prepare('INSERT INTO session (id) VALUES (?)');
	for (let i = 0; i < sessions; i++) insert.run(`session-${i}`);
	db.close();
	return path;
}

/** Create a WAL-mode fixture and keep the writer open so the -wal stays live. */
function createWalFixture(sessions = 2): { path: string; writer: Database } {
	const path = join(tempDir(), 'wal-fixture.db');
	const writer = new Database(path);
	writer.exec('PRAGMA journal_mode = WAL;');
	writer.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);');
	const insert = writer.prepare('INSERT INTO session (id) VALUES (?)');
	for (let i = 0; i < sessions; i++) insert.run(`session-${i}`);
	return { path, writer };
}

afterEach(() => {
	if (originalOpencodeDb === undefined) delete process.env.OPENCODE_DB;
	else process.env.OPENCODE_DB = originalOpencodeDb;
});

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test('resolveDbPath defaults to the live opencode database path', async () => {
	delete process.env.OPENCODE_DB;
	const mod = await freshDbModule();
	expect(mod.resolveDbPath()).toBe(DEFAULT_DB_PATH);
});

test('resolveDbPath is overridden by OPENCODE_DB', async () => {
	const path = createFixtureDb(0);
	process.env.OPENCODE_DB = path;
	const mod = await freshDbModule();
	expect(mod.resolveDbPath()).toBe(path);
});

test('getDb opens read-only: query_only=1, busy_timeout=5000, singleton', async () => {
	const path = createFixtureDb(3);
	process.env.OPENCODE_DB = path;
	const mod = await freshDbModule();

	const db = mod.getDb();
	expect(db.query('PRAGMA query_only').get()).toEqual({ query_only: 1 });
	expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
	expect(mod.getDb()).toBe(db);
});

test('DDL and DML are rejected on the read-only connection', async () => {
	const path = createFixtureDb(3);
	process.env.OPENCODE_DB = path;
	const mod = await freshDbModule();
	const db = mod.getDb();

	const writes = [
		'CREATE TABLE extra (id INTEGER)',
		"INSERT INTO session (id) VALUES ('new-row')",
		"UPDATE session SET id = 'renamed' WHERE id = 'session-0'",
		"DELETE FROM session WHERE id = 'session-0'"
	];
	for (const sql of writes) {
		expect(() => db.exec(sql)).toThrow(/readonly/i);
	}

	// Nothing was written.
	expect(mod.healthCheck()).toEqual({ ok: true, dbPath: path, sessions: 3 });
});

test('a read does not mutate the database file (no write/checkpoint)', async () => {
	const path = createFixtureDb(3);
	const before = readFileSync(path);
	process.env.OPENCODE_DB = path;
	const mod = await freshDbModule();

	const report = mod.healthCheck();
	expect(report).toEqual({ ok: true, dbPath: path, sessions: 3 });

	expect(readFileSync(path).equals(before)).toBe(true);
	expect(existsSync(`${path}-wal`)).toBe(false);
	expect(existsSync(`${path}-journal`)).toBe(false);
});

test('reads from a live WAL fixture see committed rows without checkpointing', async () => {
	const { path, writer } = createWalFixture(2);
	try {
		const mainBefore = readFileSync(path);
		const walBefore = readFileSync(`${path}-wal`);

		process.env.OPENCODE_DB = path;
		const mod = await freshDbModule();
		// Read through the WAL, exactly like the live DB (ADR §4.1).
		expect(mod.healthCheck()).toEqual({ ok: true, dbPath: path, sessions: 2 });

		// A read-only connection must not write or checkpoint the fixture.
		expect(readFileSync(path).equals(mainBefore)).toBe(true);
		expect(readFileSync(`${path}-wal`).equals(walBefore)).toBe(true);
		expect(() => mod.getDb().exec("INSERT INTO session (id) VALUES ('nope')")).toThrow(/readonly/i);
	} finally {
		writer.close();
	}
});

test('getDb throws a clear error when the DB path does not exist', async () => {
	const missing = join(tempDir(), 'does-not-exist.db');
	process.env.OPENCODE_DB = missing;
	const mod = await freshDbModule();

	expect(() => mod.getDb()).toThrow(/not found/i);
	expect(() => mod.getDb()).toThrow(missing);
	expect(() => mod.healthCheck()).toThrow(/not found/i);
});

test('getDb wraps open failures in a clear read-only error', async () => {
	// A directory exists but is not an openable SQLite file.
	const directory = tempDir();
	process.env.OPENCODE_DB = directory;
	const mod = await freshDbModule();

	expect(() => mod.getDb()).toThrow(/Cannot open the opencode database read-only/);
});

/* ------------------------------------------------------------------ */
/* Seeded settings dbPath (task #257, ADR §5.2)                       */
/* ------------------------------------------------------------------ */

/**
 * These tests exercise the live-apply path: a settings file seeded with
 * `dbPath` drives `getDb()` without needing `OPENCODE_DB`. A subsequent
 * `updateStoredSettings` call swaps the effective path and the cached
 * connection is dropped so the next `getDb()` reopens the new path.
 *
 * Because `db.ts` imports `settings.ts` (which has global mutable state),
 * each scenario uses a globally unique SETTINGS_FILE and a cache-busted
 * db module import.
 */

beforeEach(() => {
	// Give every scenario its own isolated settings file so the global cache
	// in `settings.ts` cannot leak state between tests.
	process.env.SETTINGS_FILE = join(tmpdir(), `db-settings-${crypto.randomUUID()}.json`);
});

test('getDb opens the dbPath seeded in SETTINGS_FILE', async () => {
	const dir = tempDir();
	const dbPath = join(dir, 'seeded.db');
	const db = new Database(dbPath);
	db.exec('CREATE TABLE session (id TEXT PRIMARY KEY);');
	const ins = db.prepare('INSERT INTO session (id) VALUES (?)');
	for (let i = 0; i < 4; i++) ins.run(`seed-${i}`);
	db.close();

	// Seed the settings file directly (bypassing the typed API).
	writeFileSync(
		process.env.SETTINGS_FILE!,
		JSON.stringify({ version: 1, dbPath }),
		'utf8'
	);
	delete process.env.OPENCODE_DB;

	const mod = await freshDbModule();
	expect(mod.resolveDbPath()).toBe(dbPath);
	const conn = mod.getDb();
	expect(conn.query('PRAGMA query_only').get()).toEqual({ query_only: 1 });
	expect(mod.healthCheck()).toEqual({ ok: true, dbPath, sessions: 4 });
});

test('after updateStoredSettings the next getDb/healthCheck uses the new path and closes the old', async () => {
	const dir = tempDir();
	const firstPath = join(dir, 'first.db');
	const secondPath = join(dir, 'second.db');

	for (const p of [firstPath, secondPath]) {
		const db = new Database(p);
		db.exec('CREATE TABLE session (id TEXT PRIMARY KEY);');
		db.close();
	}

	writeFileSync(
		process.env.SETTINGS_FILE!,
		JSON.stringify({ version: 1, dbPath: firstPath }),
		'utf8'
	);
	delete process.env.OPENCODE_DB;

	const mod = await freshDbModule();
	expect(mod.resolveDbPath()).toBe(firstPath);
	const firstConn = mod.getDb();
	expect(mod.healthCheck().dbPath).toBe(firstPath);

	// Update the settings store via the SAME module instance that db.ts uses.
	// Importing without a bust query string returns the cached settings module,
	// which is the same instance db.ts imported.
	const { updateStoredSettings } = (await import('./settings')) as {
		updateStoredSettings: (p: { dbPath?: string | null }) => unknown;
	};
	updateStoredSettings({ dbPath: secondPath });

	// The next getDb() must reopen at the new path (old conn was dropped).
	expect(mod.resolveDbPath()).toBe(secondPath);
	const secondConn = mod.getDb();
	expect(secondConn).not.toBe(firstConn); // different handle
	expect(mod.healthCheck().dbPath).toBe(secondPath);
	// The old connection is now closed.
	expect(() => firstConn.exec('SELECT 1')).toThrow();
});

