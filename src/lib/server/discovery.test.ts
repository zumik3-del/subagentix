import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Unit tests for `discoverOpencodeDbs` and `discoverZiptaskBaseUrls`
 * (task #257, ADR §7).
 *
 * Both functions are server-side, bounded, read-only and never throw.
 * Discovery tests isolate filesystem state via temp HOME / XDG / cwd injection.
 */

interface DiscoveryModule {
	discoverOpencodeDbs: (options?: { extraPaths?: string[] }) => {
		candidates: Array<{ path: string; sessions: number; mtimeMs: number }>;
		recommended: string | null;
	};
	discoverZiptaskBaseUrls: () => Promise<{
		candidates: Array<{ baseUrl: string; source: 'settings-json' | 'probe' }>;
		recommended: string | null;
	}>;
}

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_DATA_HOME;
const originalZiptaskHome = process.env.ZIPTASK_HOME;
const originalSettingsFile = process.env.SETTINGS_FILE;
const bustPrefix = crypto.randomUUID();
let bust = 0;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'subagentix-disc-'));
	tempDirs.push(dir);
	return dir;
}

/** Absolute + cache-busted specifier for a fresh module instance. */
function freshModule(): Promise<DiscoveryModule> {
	const url = new URL('./discovery.ts', import.meta.url);
	return import(`${url.pathname}?bust=${bustPrefix}-${++bust}`) as Promise<DiscoveryModule>;
}

/** Build a minimal opencode-shaped fixture under `dir`. */
function buildOpencodeFixture(dir: string, sessions = 3): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'opencode.db');
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

/** Walk a dir tree and return sorted relative paths for diffing. */
function walkDir(dir: string, prefix = ''): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const rel = prefix ? `${prefix}/${name}` : name;
		out.push(rel);
		const entries = readdirSync(full, { withFileTypes: true });
		for (const child of entries) {
			if (child.isDirectory()) {
				out.push(...walkDir(join(full, child.name), rel));
			} else {
				out.push(`${rel}/${child.name}`);
			}
		}
	}
	return out.sort();
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = originalXdg;
	if (originalZiptaskHome === undefined) delete process.env.ZIPTASK_HOME;
	else process.env.ZIPTASK_HOME = originalZiptaskHome;
});

beforeEach(() => {
	// Isolate the settings store so a previous test's written file cannot leak
	// into discovery (settings.ts caches globally and is NOT cache-busted by the
	// discovery module's specifier).
	process.env.SETTINGS_FILE = join(tmpdir(), `disc-settings-${crypto.randomUUID()}.json`);
	delete process.env.OPENCODE_DB;
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = originalXdg;
	if (originalZiptaskHome === undefined) delete process.env.ZIPTASK_HOME;
	else process.env.ZIPTASK_HOME = originalZiptaskHome;
	if (originalSettingsFile === undefined) delete process.env.SETTINGS_FILE;
	else process.env.SETTINGS_FILE = originalSettingsFile;
});

/* ------------------------------------------------------------------ */
/* opencode discovery                                                 */
/* ------------------------------------------------------------------ */

test('discoverOpencodeDbs finds a fixture under HOME/.local/share/opencode', async () => {
	const home = tempDir();
	process.env.HOME = home;
	delete process.env.XDG_DATA_HOME;
	const dbPath = buildOpencodeFixture(join(home, '.local', 'share', 'opencode'), 7);

	const mod = await freshModule();
	const result = mod.discoverOpencodeDbs();
	expect(result.candidates.length).toBeGreaterThan(0);
	expect(result.candidates.some((c) => c.path === dbPath)).toBe(true);
	expect(result.recommended).toBe(dbPath);
});

test('discoverOpencodeDbs deduplicates when XDG and HOME overlap', async () => {
	const xdg = tempDir();
	process.env.XDG_DATA_HOME = xdg;
	process.env.HOME = xdg; // same root -> both paths resolve to the same file
	const dbPath = buildOpencodeFixture(join(xdg, 'opencode'), 2);

	const mod = await freshModule();
	const result = mod.discoverOpencodeDbs();
	const matches = result.candidates.filter((c) => c.path === dbPath);
	expect(matches.length).toBe(1); // deduped
});

test('discoverOpencodeDbs respects the OPENCODE_CANDIDATE_CAP (≤ 8)', async () => {
	const mod = await freshModule();
	const result = mod.discoverOpencodeDbs();
	expect(result.candidates.length).toBeLessThanOrEqual(8);
});

test('discoverOpencodeDbs extraPaths are probed first and can add a candidate', async () => {
	const dir = tempDir();
	const dbPath = buildOpencodeFixture(dir, 5);

	const mod = await freshModule();
	const result = mod.discoverOpencodeDbs({ extraPaths: [dbPath] });
	expect(result.candidates.length).toBeGreaterThan(0);
	expect(result.candidates[0].path).toBe(dbPath);
	expect(result.recommended).toBe(dbPath);
});

test('discoverOpencodeDbs returns empty when nothing is found, without throwing', async () => {
	const empty = tempDir();
	process.env.HOME = empty;
	delete process.env.XDG_DATA_HOME;
	delete process.env.OPENCODE_DB;

	const mod = await freshModule();
	const result = mod.discoverOpencodeDbs();
	expect(result.candidates).toEqual([]);
	expect(result.recommended).toBeNull();
});

/* ------------------------------------------------------------------ */
/* ziptask discovery                                                  */
/* ------------------------------------------------------------------ */

test('discoverZiptaskBaseUrls reads a temp ~/.ziptask/settings.json and returns settings-json candidate', async () => {
	const ziptaskHome = tempDir();
	process.env.ZIPTASK_HOME = ziptaskHome;
	const cfgDir = join(ziptaskHome, '.ziptask');
	mkdirSync(cfgDir, { recursive: true });
	writeFileSync(
		join(cfgDir, 'settings.json'),
		JSON.stringify({ host: '127.0.0.1', port: 3005 }),
		'utf8'
	);

	const mod = await freshModule();
	const result = await mod.discoverZiptaskBaseUrls();
	expect(result.candidates.length).toBeGreaterThan(0);
	const jsonCandidate = result.candidates.find((c) => c.source === 'settings-json');
	expect(jsonCandidate).toBeDefined();
	expect(jsonCandidate!.baseUrl).toBe('http://127.0.0.1:3005');
});

test('discoverZiptaskBaseUrls normalises 0.0.0.0 to 127.0.0.1', async () => {
	const ziptaskHome = tempDir();
	process.env.ZIPTASK_HOME = ziptaskHome;
	const cfgDir = join(ziptaskHome, '.ziptask');
	mkdirSync(cfgDir, { recursive: true });
	writeFileSync(
		join(cfgDir, 'settings.json'),
		JSON.stringify({ host: '0.0.0.0', port: 8080 }),
		'utf8'
	);

	const mod = await freshModule();
	const result = await mod.discoverZiptaskBaseUrls();
	const jsonCandidate = result.candidates.find((c) => c.source === 'settings-json');
	expect(jsonCandidate!.baseUrl).toBe('http://127.0.0.1:8080');
});

test('discoverZiptaskBaseUrls returns empty when the config file is absent', async () => {
	const empty = tempDir();
	process.env.ZIPTASK_HOME = empty;

	const mod = await freshModule();
	const result = await mod.discoverZiptaskBaseUrls();
	// Only probe candidates may appear (and they require a live server).
	// In this empty env, no probe should succeed.
	expect(result.candidates.every((c) => c.source !== 'settings-json')).toBe(true);
});

test('discoverZiptaskBaseUrls de-duplicates settings-json and probe results', async () => {
	const ziptaskHome = tempDir();
	process.env.ZIPTASK_HOME = ziptaskHome;
	const cfgDir = join(ziptaskHome, '.ziptask');
	mkdirSync(cfgDir, { recursive: true });
	// Point config at a port we know will NOT have a server (avoid false probe hit).
	writeFileSync(
		join(cfgDir, 'settings.json'),
		JSON.stringify({ host: '127.0.0.1', port: 59999 }),
		'utf8'
	);

	const mod = await freshModule();
	const result = await mod.discoverZiptaskBaseUrls();
	const bases = result.candidates.map((c) => c.baseUrl);
	expect(bases).toEqual([...new Set(bases)]); // no duplicates
});

test('discoverZiptaskBaseUrls is non-writing: no filesystem side effects', async () => {
	const ziptaskHome = tempDir();
	process.env.ZIPTASK_HOME = ziptaskHome;
	const cfgDir = join(ziptaskHome, '.ziptask');
	mkdirSync(cfgDir, { recursive: true });
	writeFileSync(
		join(cfgDir, 'settings.json'),
		JSON.stringify({ host: '127.0.0.1', port: 59998 }),
		'utf8'
	);
	const before = walkDir(ziptaskHome);

	const mod = await freshModule();
	await mod.discoverZiptaskBaseUrls();

	const after = walkDir(ziptaskHome);
	expect(after).toEqual(before);
});
