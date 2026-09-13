import { afterAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Unit tests for `probeOpencodeDb` (task #257, ADR §7.1).
 *
 * The probe opens candidates read-only and checks the opencode signature
 * (`session` + `message` + `part` tables = 3). It never writes to the
 * candidate file.
 */

interface ProbeModule {
	probeOpencodeDb: (path: string) => { path: string; sessions: number; mtimeMs: number } | null;
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'subagentix-probe-'));
	tempDirs.push(dir);
	return dir;
}

/** Create a minimal opencode-shaped fixture (3 tables + N sessions). */
function buildOpencodeFixture(sessions = 3): string {
	const path = join(tempDir(), 'opencode.db');
	const db = new Database(path);
	db.exec(`
		CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);
		CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
		CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
	`);
	const ins = db.prepare('INSERT INTO session (id) VALUES (?)');
	for (let i = 0; i < sessions; i++) ins.run(`s${i}`);
	db.close();
	return path;
}

/** Create a plain SQLite file with only a single table (not opencode-shaped). */
function buildPlainSqlite(): string {
	const path = join(tempDir(), 'plain.db');
	const db = new Database(path);
	db.exec('CREATE TABLE foo (id TEXT PRIMARY KEY);');
	db.close();
	return path;
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test('probeOpencodeDb accepts a valid opencode fixture and returns session count', async () => {
	const mod = (await import('./db-probe')) as ProbeModule;
	const path = buildOpencodeFixture(5);
	const probe = mod.probeOpencodeDb(path);
	expect(probe).not.toBeNull();
	expect(probe!.path).toBe(path);
	expect(probe!.sessions).toBe(5);
	expect(typeof probe!.mtimeMs).toBe('number');
});

test('probeOpencodeDb returns null for a missing path', async () => {
	const mod = (await import('./db-probe')) as ProbeModule;
	expect(mod.probeOpencodeDb(join(tempDir(), 'nope.db'))).toBeNull();
});

test('probeOpencodeDb returns null for a directory', async () => {
	const mod = (await import('./db-probe')) as ProbeModule;
	expect(mod.probeOpencodeDb(tempDir())).toBeNull();
});

test('probeOpencodeDb returns null for a plain SQLite file (wrong schema)', async () => {
	const mod = (await import('./db-probe')) as ProbeModule;
	const path = buildPlainSqlite();
	expect(mod.probeOpencodeDb(path)).toBeNull();
});

test('probeOpencodeDb returns null for an empty file', async () => {
	const mod = (await import('./db-probe')) as ProbeModule;
	const path = join(tempDir(), 'empty.db');
	writeFileSync(path, '', 'utf8');
	expect(mod.probeOpencodeDb(path)).toBeNull();
});

test('probeOpencodeDb is read-only: fixture bytes are unchanged after probing', async () => {
	const mod = (await import('./db-probe')) as ProbeModule;
	const path = buildOpencodeFixture(2);
	const before = readFileSync(path);

	const probe = mod.probeOpencodeDb(path);
	expect(probe).not.toBeNull();

	expect(readFileSync(path).equals(before)).toBe(true);
	// No -wal / -shm files created by the read-only probe.
	expect(existsSync(`${path}-wal`)).toBe(false);
	expect(existsSync(`${path}-journal`)).toBe(false);
});

test('probeOpencodeDb rejects a fixture missing one of the three required tables', async () => {
	const path = join(tempDir(), 'partial.db');
	const db = new Database(path);
	db.exec('CREATE TABLE session (id TEXT PRIMARY KEY);');
	db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);');
	// Missing `part` table.
	db.close();

	const mod = (await import('./db-probe')) as ProbeModule;
	expect(mod.probeOpencodeDb(path)).toBeNull();
});

test('probeOpencodeDb with a WAL-mode fixture sees committed rows without checkpointing', async () => {
	const path = join(tempDir(), 'wal.db');
	const writer = new Database(path);
	writer.exec('PRAGMA journal_mode = WAL;');
	writer.exec(`
		CREATE TABLE session (id TEXT PRIMARY KEY);
		CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
		CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
	`);
	const ins = writer.prepare('INSERT INTO session (id) VALUES (?)');
	for (let i = 0; i < 4; i++) ins.run(`w${i}`);
	writer.close();

	const mainBefore = readFileSync(path);
	const walBefore = readFileSync(`${path}-wal`);

	const mod = (await import('./db-probe')) as ProbeModule;
	const probe = mod.probeOpencodeDb(path);
	expect(probe).not.toBeNull();
	expect(probe!.sessions).toBe(4);

	// Read-only probe must not have checkpointed or mutated the files.
	expect(readFileSync(path).equals(mainBefore)).toBe(true);
	expect(readFileSync(`${path}-wal`).equals(walBefore)).toBe(true);
});
