import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WidgetPlacement } from '$lib/widgets/registry';

/**
 * Unit tests for the runtime settings store (task #257, ADR §4).
 *
 * Every test isolates `SETTINGS_FILE` to a temp path so no scenario mutates
 * the developer's real settings or other tests. A fresh module instance is
 * imported per scenario via cache-busted specifier so the in-memory cache
 * starts empty each time.
 */

const tempDirs: string[] = [];
const originalSettingsFile = process.env.SETTINGS_FILE;
const bustPrefix = crypto.randomUUID();
let bust = 0;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'subagentix-settings-'));
	tempDirs.push(dir);
	return dir;
}

/** Absolute + cache-busted specifier for a fresh module instance. */
function freshSettingsModule() {
	const url = new URL('./settings.ts', import.meta.url);
	return import(`${url.pathname}?bust=${bustPrefix}-${++bust}`) as Promise<{
		DEFAULT_DB_PATH: string;
		settingsFilePath: () => string;
		getStoredSettings: () => {
			dbPath?: string | null;
			ziptaskBaseUrl?: string | null;
			ziptaskEnabled?: boolean | null;
			dashboardWidgets?: Array<{ id: string; width: number; height: number }> | null;
			dashboardFilter?: { period: string; scope: string | null } | null;
		};
		updateStoredSettings: (patch: {
			dbPath?: string | null;
			ziptaskBaseUrl?: string | null;
			ziptaskEnabled?: boolean | null;
			dashboardWidgets?: unknown;
			dashboardFilter?: { period: string; scope: string | null } | null;
		}) => {
			dbPath?: string | null;
			ziptaskBaseUrl?: string | null;
			ziptaskEnabled?: boolean | null;
			dashboardWidgets?: unknown;
			dashboardFilter?: { period: string; scope: string | null } | null;
		};
		resolveDbPath: () => string;
		resolveZiptaskBaseUrl: () => string | null;
		resolveZiptaskEnabled: () => boolean;
		resolveDashboardWidgets: () => Array<{ id: string; width: number; height: number }>;
		resolveDashboardFilter: () => { period: string; scope: string | null };
		onSettingsChange: (cb: (next: { dbPath?: string | null; ziptaskBaseUrl?: string | null }) => void) => () => void;
		normaliseDbPath: (value: unknown) => string;
		normaliseZiptaskBaseUrl: (value: unknown) => string;
		normaliseZiptaskEnabled: (value: unknown) => boolean;
		normaliseDashboardWidgets: (value: unknown) => Array<{ id: string; width: number; height: number }>;
		normaliseDashboardFilter: (value: unknown) => { period: string; scope: string | null };
		SettingsValidationError: new (message: string, field: string) => { message: string; field: string };
	}>;
}

beforeEach(() => {
	// Reset SETTINGS_FILE before each test so every scenario starts clean.
	if (originalSettingsFile === undefined) delete process.env.SETTINGS_FILE;
	else process.env.SETTINGS_FILE = originalSettingsFile;
});

afterEach(() => {
	if (originalSettingsFile === undefined) delete process.env.SETTINGS_FILE;
	else process.env.SETTINGS_FILE = originalSettingsFile;
});

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Path resolution                                                    */
/* ------------------------------------------------------------------ */

test('settingsFilePath uses SETTINGS_FILE when set', async () => {
	const file = join(tempDir(), 'my-settings.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();
	expect(mod.settingsFilePath()).toBe(file);
});

test('settingsFilePath falls back to STATE_DIRECTORY/settings.json', async () => {
	const stateDir = join(tempDir(), 'state');
	delete process.env.SETTINGS_FILE;
	process.env.STATE_DIRECTORY = stateDir;
	const mod = await freshSettingsModule();
	expect(mod.settingsFilePath()).toBe(join(stateDir, 'settings.json'));
});

test('settingsFilePath falls back to cwd/.data/settings.json', async () => {
	delete process.env.SETTINGS_FILE;
	delete process.env.STATE_DIRECTORY;
	const mod = await freshSettingsModule();
	expect(mod.settingsFilePath()).toBe(join(process.cwd(), '.data', 'settings.json'));
});

/* ------------------------------------------------------------------ */
/* Missing / corrupt file → {} semantics, file untouched              */
/* ------------------------------------------------------------------ */

test('missing file yields empty stored settings and no throw', async () => {
	const dir = tempDir();
	const file = join(dir, 'nope.json');
	// Explicitly point at a non-existent file so the environment cannot leak.
	process.env.SETTINGS_FILE = file;
	// Also clear any env fallbacks that might supply a value.
	delete process.env.OPENCODE_DB;
	delete process.env.ZIPTASK_BASE_URL;
	const mod = await freshSettingsModule();
	expect(existsSync(file)).toBe(false);
	expect(mod.getStoredSettings()).toEqual({});
	expect(mod.resolveDbPath()).toBe(mod.DEFAULT_DB_PATH);
	expect(mod.resolveZiptaskBaseUrl()).toBeNull();
});

test('corrupt JSON yields {} without mutating the file', async () => {
	const dir = tempDir();
	const file = join(dir, 'corrupt.json');
	writeFileSync(file, '{this is not json', 'utf8');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();
	expect(mod.getStoredSettings()).toEqual({});
	expect(readFileSync(file, 'utf8')).toBe('{this is not json');
});

test('a non-object JSON value (array / string / null) degrades to {}', async () => {
	for (const payload of ['["a"]', '"hello"', 'null', '42']) {
		const dir = tempDir();
		const file = join(dir, 'shape.json');
		writeFileSync(file, payload, 'utf8');
		process.env.SETTINGS_FILE = file;
		const mod = await freshSettingsModule();
		expect(mod.getStoredSettings()).toEqual({});
	}
});

/* ------------------------------------------------------------------ */
/* Write → read round-trip                                            */
/* ------------------------------------------------------------------ */

test('updateStoredSettings writes and the next read returns the value', async () => {
	const dir = tempDir();
	const file = join(dir, 'rt.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	const next = mod.updateStoredSettings({ dbPath: '/tmp/a.db' });
	expect(next.dbPath).toBe('/tmp/a.db');
	expect(mod.getStoredSettings().dbPath).toBe('/tmp/a.db');
	// File actually exists on disk.
	expect(existsSync(file)).toBe(true);
	const disk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
	expect(disk).toHaveProperty('version', 2);
	expect(disk.dbPath).toBe('/tmp/a.db');
});

test('null clears a key: subsequent get returns undefined for that key', async () => {
	const dir = tempDir();
	const file = join(dir, 'clear.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	mod.updateStoredSettings({ dbPath: '/tmp/x.db' });
	expect(mod.getStoredSettings().dbPath).toBe('/tmp/x.db');

	mod.updateStoredSettings({ dbPath: null });
	// null is preserved in the cached object (distinguishes "explicitly cleared"
	// from "not present"). The file on disk stores `null` for the key.
	expect(mod.getStoredSettings().dbPath).toBeNull();
	const disk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
	expect(disk.dbPath).toBeNull();
});

test('unknown keys are dropped on write', async () => {
	const dir = tempDir();
	const file = join(dir, 'unknown.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	// Bypass the typed API and write an unknown key directly to the file.
	writeFileSync(
		file,
		JSON.stringify({ version: 1, dbPath: '/tmp/q.db', exoticKey: 42 }),
		'utf8'
	);
	// Re-import to clear the cache.
	const mod2 = await freshSettingsModule();
	expect(mod2.getStoredSettings().dbPath).toBe('/tmp/q.db');
	expect((mod2.getStoredSettings() as Record<string, unknown>).exoticKey).toBeUndefined();
});

/* ------------------------------------------------------------------ */
/* normaliseDbPath validators                                          */
/* ------------------------------------------------------------------ */

test('normaliseDbPath accepts an absolute path and resolves it', async () => {
	const dir = tempDir();
	const mod = await freshSettingsModule();
	// path.resolve collapses the `..` segment.
	const resolved = mod.normaliseDbPath(join(dir, 'sub', '..', 'a.db'));
	expect(resolved).toBe(join(dir, 'a.db'));
});

test('normaliseDbPath rejects relative paths', async () => {
	const mod = await freshSettingsModule();
	expect(() => mod.normaliseDbPath('relative/db.db')).toThrow(/absolute/i);
});

test('normaliseDbPath rejects NUL characters', async () => {
	const mod = await freshSettingsModule();
	expect(() => mod.normaliseDbPath('/tmp/evil\x00.db')).toThrow(/NUL/i);
});

test('normaliseDbPath rejects paths exceeding MAX length (4096)', async () => {
	const mod = await freshSettingsModule();
	const long = '/tmp/' + 'a'.repeat(4100) + '.db';
	expect(() => mod.normaliseDbPath(long)).toThrow(/at most 4096/i);
});

test('normaliseDbPath rejects empty / whitespace-only strings', async () => {
	const mod = await freshSettingsModule();
	expect(() => mod.normaliseDbPath('')).toThrow(/non-empty/i);
	expect(() => mod.normaliseDbPath('   ')).toThrow(/non-empty/i);
});

test('normaliseDbPath rejects non-string values', async () => {
	const mod = await freshSettingsModule();
	expect(() => mod.normaliseDbPath(42 as unknown as string)).toThrow(/must be a non-empty/i);
	expect(() => mod.normaliseDbPath(null as unknown as string)).toThrow(/must be a non-empty/i);
});

/* ------------------------------------------------------------------ */
/* normaliseZiptaskBaseUrl validators                                  */
/* ------------------------------------------------------------------ */

test('normaliseZiptaskBaseUrl accepts a plain http URL and strips trailing slash', async () => {
	const mod = await freshSettingsModule();
	expect(mod.normaliseZiptaskBaseUrl('http://127.0.0.1:3005/')).toBe('http://127.0.0.1:3005');
	expect(mod.normaliseZiptaskBaseUrl('https://example.com/ziptask/')).toBe('https://example.com/ziptask');
});

test('normaliseZiptaskBaseUrl rejects non-http(s) schemes', async () => {
	const mod = await freshSettingsModule();
	expect(() => mod.normaliseZiptaskBaseUrl('ftp://host')).toThrow(/http or https/i);
	expect(() => mod.normaliseZiptaskBaseUrl('file:///etc/passwd')).toThrow(/http or https/i);
});

test('normaliseZiptaskBaseUrl rejects URLs with embedded userinfo', async () => {
	const mod = await freshSettingsModule();
	expect(() => mod.normaliseZiptaskBaseUrl('http://user:pass@host')).toThrow(/credentials/i);
});

test('normaliseZiptaskBaseUrl rejects URLs missing a host', async () => {
	const mod = await freshSettingsModule();
	// A bare scheme with no authority is rejected as an invalid URL.
	expect(() => mod.normaliseZiptaskBaseUrl('http://')).toThrow(/valid URL/i);
});

test('normaliseZiptaskBaseUrl rejects empty / whitespace-only / non-string', async () => {
	const mod = await freshSettingsModule();
	expect(() => mod.normaliseZiptaskBaseUrl('')).toThrow(/non-empty/i);
	expect(() => mod.normaliseZiptaskBaseUrl('   ')).toThrow(/non-empty/i);
	expect(() => mod.normaliseZiptaskBaseUrl(42 as unknown as string)).toThrow(/non-empty/i);
});

test('normaliseZiptaskBaseUrl rejects an unparsable string', async () => {
	const mod = await freshSettingsModule();
	expect(() => mod.normaliseZiptaskBaseUrl('not-a-url')).toThrow(/valid URL/i);
});

/* ------------------------------------------------------------------ */
/* Atomic write: no tmp leftovers, mode 0600                           */
/* ------------------------------------------------------------------ */

test('atomic write leaves no *.tmp-* file and mode is 0600', async () => {
	const dir = tempDir();
	const file = join(dir, 'atomic.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	mod.updateStoredSettings({ dbPath: '/tmp/atomic.db' });
	expect(existsSync(file)).toBe(true);
	// No tmp remnants.
	const entries = readdirSync(dir);
	expect(entries.filter((e) => e.startsWith('atomic') && e.includes('.tmp-'))).toEqual([]);
	// Mode 0600.
	const mode = statSync(file).mode & 0o777;
	expect(mode).toBe(0o600);
});

/* ------------------------------------------------------------------ */
/* onSettingsChange fires and resolveDbPath reflects immediately      */
/* ------------------------------------------------------------------ */

test('onSettingsChange listener fires with the new settings on update', async () => {
	const dir = tempDir();
	const file = join(dir, 'change.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	const received: Array<{ dbPath?: string | null }> = [];
	const unsubscribe = mod.onSettingsChange((next) => received.push(next));

	mod.updateStoredSettings({ dbPath: '/tmp/first.db' });
	expect(received).toHaveLength(1);
	expect(received[0].dbPath).toBe('/tmp/first.db');
	expect(mod.resolveDbPath()).toBe('/tmp/first.db');

	unsubscribe();
	mod.updateStoredSettings({ dbPath: '/tmp/second.db' });
	// After unsubscribe no further callbacks.
	expect(received).toHaveLength(1);
});

test('resolveDbPath reflects a settings write without re-import', async () => {
	const dir = tempDir();
	const file = join(dir, 'reflect.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	expect(mod.resolveDbPath()).toBe(mod.DEFAULT_DB_PATH);
	mod.updateStoredSettings({ dbPath: '/tmp/live.db' });
	expect(mod.resolveDbPath()).toBe('/tmp/live.db');
});

test('a listener that throws does not prevent the write from succeeding', async () => {
	const dir = tempDir();
	const file = join(dir, 'tolerant.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	mod.onSettingsChange(() => {
		throw new Error('boom');
	});
	// Should not throw; the write still succeeds.
	expect(() => mod.updateStoredSettings({ dbPath: '/tmp/tol.db' })).not.toThrow();
	expect(mod.getStoredSettings().dbPath).toBe('/tmp/tol.db');
});

/* ------------------------------------------------------------------ */
/* Stored settings ignores invalid values per key (graceful degradation)*/
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* ziptask integration toggle                              */
/* ------------------------------------------------------------------ */

/** Run `fn` with `ZIPTASK_BASE_URL` / `ZIPTASK_ENABLED` temporarily set. */
async function withZiptaskEnv(
	overrides: { base?: string; enabled?: string },
	fn: () => void | Promise<void>
): Promise<void> {
	const prevBase = process.env.ZIPTASK_BASE_URL;
	const prevEnabled = process.env.ZIPTASK_ENABLED;
	try {
		delete process.env.ZIPTASK_BASE_URL;
		delete process.env.ZIPTASK_ENABLED;
		if (overrides.base !== undefined) process.env.ZIPTASK_BASE_URL = overrides.base;
		if (overrides.enabled !== undefined) process.env.ZIPTASK_ENABLED = overrides.enabled;
		await fn();
	} finally {
		if (prevBase === undefined) delete process.env.ZIPTASK_BASE_URL;
		else process.env.ZIPTASK_BASE_URL = prevBase;
		if (prevEnabled === undefined) delete process.env.ZIPTASK_ENABLED;
		else process.env.ZIPTASK_ENABLED = prevEnabled;
	}
}

test('resolveZiptaskEnabled defaults to the base URL presence', async () => {
	await withZiptaskEnv({}, async () => {
		process.env.SETTINGS_FILE = join(tempDir(), 'derive.json');
		const off = await freshSettingsModule();
		expect(off.resolveZiptaskEnabled()).toBe(false);

		process.env.ZIPTASK_BASE_URL = 'http://127.0.0.1:3005';
		const on = await freshSettingsModule();
		expect(on.resolveZiptaskEnabled()).toBe(true);
	});
});

test('resolveZiptaskEnabled: ZIPTASK_ENABLED=0 disables despite a base URL', async () => {
	await withZiptaskEnv({ base: 'http://127.0.0.1:3005', enabled: '0' }, async () => {
		process.env.SETTINGS_FILE = join(tempDir(), 'env-off.json');
		const mod = await freshSettingsModule();
		expect(mod.resolveZiptaskEnabled()).toBe(false);
	});
});

test('a stored ziptaskEnabled override wins over the env default', async () => {
	await withZiptaskEnv({ enabled: '0' }, async () => {
		process.env.SETTINGS_FILE = join(tempDir(), 'override.json');
		const mod = await freshSettingsModule();

		mod.updateStoredSettings({ ziptaskEnabled: true });
		expect(mod.getStoredSettings().ziptaskEnabled).toBe(true);
		expect(mod.resolveZiptaskEnabled()).toBe(true);

		mod.updateStoredSettings({ ziptaskEnabled: false });
		expect(mod.resolveZiptaskEnabled()).toBe(false);

		// null clears the override, so the env layer applies again.
		mod.updateStoredSettings({ ziptaskEnabled: null });
		expect(mod.getStoredSettings().ziptaskEnabled).toBeNull();
		expect(mod.resolveZiptaskEnabled()).toBe(false);
	});
});

test('ziptaskEnabled round-trips through the settings file', async () => {
	const dir = tempDir();
	const file = join(dir, 'bool.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	mod.updateStoredSettings({ ziptaskEnabled: false });
	const disk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
	expect(disk.ziptaskEnabled).toBe(false);

	const reread = await freshSettingsModule();
	expect(reread.getStoredSettings().ziptaskEnabled).toBe(false);
});

test('normaliseZiptaskEnabled accepts booleans and rejects other types', async () => {
	const mod = await freshSettingsModule();
	expect(mod.normaliseZiptaskEnabled(true)).toBe(true);
	expect(mod.normaliseZiptaskEnabled(false)).toBe(false);
	expect(() => mod.normaliseZiptaskEnabled('true' as unknown as boolean)).toThrow(/boolean/i);
	expect(() => mod.normaliseZiptaskEnabled(1 as unknown as boolean)).toThrow(/boolean/i);
});

test('invalid dbPath in the file is ignored; other keys still work', async () => {
	const dir = tempDir();
	const file = join(dir, 'partial.json');
	process.env.SETTINGS_FILE = file;
	// Write an invalid dbPath alongside a valid ziptaskBaseUrl.
	writeFileSync(
		file,
		JSON.stringify({
			version: 1,
			dbPath: 'relative-path', // invalid
			ziptaskBaseUrl: 'http://127.0.0.1:3005'
		}),
		'utf8'
	);
	const mod = await freshSettingsModule();
	const stored = mod.getStoredSettings();
	expect(stored.dbPath).toBeUndefined(); // invalid key dropped
	expect(stored.ziptaskBaseUrl).toBe('http://127.0.0.1:3005');
	});

/* ------------------------------------------------------------------ */
/* dashboardWidgets normalisation & round-trip                          */
/* ------------------------------------------------------------------ */

test('normaliseDashboardWidgets rejects a non-array', async () => {
	for (const value of [null, 'kpi', 42, { id: 'kpi' }] as unknown[]) {
		const mod = await freshSettingsModule();
		expect(() => mod.normaliseDashboardWidgets(value)).toThrow(/dashboardWidgets/);
	}
});

test('normaliseDashboardWidgets rejects an oversized list (>24)', async () => {
	const mod = await freshSettingsModule();
	const tooMany = Array.from({ length: 25 }, (_, i) => `widget-${i}`);
	expect(() => mod.normaliseDashboardWidgets(tooMany)).toThrow(/at most 24/);
});

test('normaliseDashboardWidgets rejects non-finite width', async () => {
	const mod = await freshSettingsModule();
	expect(() => mod.normaliseDashboardWidgets([{ id: 'kpi' as WidgetPlacement['id'], width: NaN }])).toThrow(
		/width must be a finite number/
	);
	expect(() => mod.normaliseDashboardWidgets([{ id: 'kpi' as WidgetPlacement['id'], width: Infinity }])).toThrow(
		/width must be a finite number/
	);
});

test('normaliseDashboardWidgets rejects non-finite height', async () => {
	const mod = await freshSettingsModule();
	expect(() => mod.normaliseDashboardWidgets([{ id: 'kpi' as WidgetPlacement['id'], height: NaN }])).toThrow(
		/height must be a finite number/
	);
	expect(() => mod.normaliseDashboardWidgets([{ id: 'kpi' as WidgetPlacement['id'], height: -Infinity }])).toThrow(
		/height must be a finite number/
	);
});

test('normaliseDashboardWidgets rejects non-object non-string entries', async () => {
	const mod = await freshSettingsModule();
	// Each entry in the array must be either a string id or a plain object.
	// Arrays, numbers, booleans, and null are rejected.
	for (const entry of [42, null, true] as unknown[]) {
		expect(() => mod.normaliseDashboardWidgets([entry])).toThrow(/must contain only ids or/);
	}
	// An array nested inside is also rejected.
	expect(() => mod.normaliseDashboardWidgets([['kpi']])).toThrow(/must contain only ids or/);
});

test('normaliseDashboardWidgets accepts legacy string[] and resolves registry defaults', async () => {
	const mod = await freshSettingsModule();
	const result = mod.normaliseDashboardWidgets(['kpi', 'agent-distribution']);
	expect(result).toEqual<WidgetPlacement[]>([
		{ id: 'kpi', width: 4, height: 2 },
		{ id: 'agent-distribution', width: 1, height: 3 }
	]);
});

test('normaliseDashboardWidgets accepts object placements with explicit sizes', async () => {
	const mod = await freshSettingsModule();
	const result = mod.normaliseDashboardWidgets([
		{ id: 'kpi', width: 2, height: 5 }
	] as unknown as unknown[]);
	expect(result).toEqual<WidgetPlacement[]>([{ id: 'kpi', width: 2, height: 5 }]);
});

test('normaliseDashboardWidgets drops objects without a known id', async () => {
	const mod = await freshSettingsModule();
	const result = mod.normaliseDashboardWidgets([
		{ width: 2, height: 5 },
		{ id: 'nope', width: 2, height: 5 },
		{ id: 'kpi', width: 2, height: 5 }
	] as unknown as unknown[]);
	expect(result).toEqual<WidgetPlacement[]>([{ id: 'kpi', width: 2, height: 5 }]);
});

test('dashboardWidgets round-trips through PUT → GET unchanged', async () => {
	const dir = tempDir();
	const file = join(dir, 'rt-widgets.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	const original: WidgetPlacement[] = [
		{ id: 'kpi', width: 3, height: 5 },
		{ id: 'top-tools', width: 2, height: 2 }
	];
	mod.updateStoredSettings({ dashboardWidgets: original });
	const readBack = mod.getStoredSettings().dashboardWidgets;
	expect(readBack).toEqual(original);
});

test('legacy string[] file degrades gracefully on read', async () => {
	const dir = tempDir();
	const file = join(dir, 'legacy.json');
	// Write a v1-style string[] file directly to disk.
	writeFileSync(
		file,
		JSON.stringify({ version: 1, dashboardWidgets: ['kpi', 'top-tools'] }),
		'utf8'
	);
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();
	const result = mod.getStoredSettings().dashboardWidgets;
	// Legacy strings are resolved to placements with registry defaults.
	expect(result).toEqual<WidgetPlacement[]>([
		{ id: 'kpi', width: 4, height: 2 },
		{ id: 'top-tools', width: 2, height: 3 }
	]);
});

test('version 2 is written on every updateStoredSettings call', async () => {
	const dir = tempDir();
	const file = join(dir, 'v2.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	mod.updateStoredSettings({ dbPath: '/tmp/test.db' });
	const disk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
	expect(disk.version).toBe(2);
});

/* ------------------------------------------------------------------ */
/* dashboardWidgets minHeight clamping                                 */
/* ------------------------------------------------------------------ */

test('normaliseDashboardWidgets clamps a v2 height below the widget minimum up to it', async () => {
	const mod = await freshSettingsModule();
	// kpi minHeight is 2; a persisted height of 0 or 1 must raise to 2.
	expect(
		mod.normaliseDashboardWidgets([{ id: 'kpi' as WidgetPlacement['id'], width: 4, height: 0 }])
		[0].height
	).toBe(2);
	expect(
		mod.normaliseDashboardWidgets([{ id: 'kpi' as WidgetPlacement['id'], width: 4, height: 1 }])
		[0].height
	).toBe(2);
	expect(
		mod.normaliseDashboardWidgets([{ id: 'kpi' as WidgetPlacement['id'], width: 4, height: 2 }])
		[0].height
	).toBe(2);
});

test('normaliseDashboardWidgets clamps each widget to its own minimum', async () => {
	const mod = await freshSettingsModule();
	const result = mod.normaliseDashboardWidgets([
		{ id: 'top-projects' as WidgetPlacement['id'], width: 2, height: 0 },
		{ id: 'top-tools' as WidgetPlacement['id'], width: 2, height: 0 },
		{ id: 'agent-distribution' as WidgetPlacement['id'], width: 1, height: 0 },
		{ id: 'sessions-per-day' as WidgetPlacement['id'], width: 2, height: 0 },
		{ id: 'cost-per-day' as WidgetPlacement['id'], width: 2, height: 0 }
	] as unknown as unknown[]);
	const byId = new Map(result.map((p) => [p.id, p]));
	// top-projects minHeight is 1; top-tools is 2; agent-distribution is 2;
	// sessions-per-day and cost-per-day are 3.
	expect(byId.get('top-projects')?.height).toBe(1);
	expect(byId.get('top-tools')?.height).toBe(2);
	expect(byId.get('agent-distribution')?.height).toBe(2);
	expect(byId.get('sessions-per-day')?.height).toBe(3);
	expect(byId.get('cost-per-day')?.height).toBe(3);
});

test('a legacy string[] file resolves registry defaults (no minHeight issue)', async () => {
	const dir = tempDir();
	const file = join(dir, 'legacy-min.json');
	writeFileSync(
		file,
		JSON.stringify({ version: 1, dashboardWidgets: ['kpi', 'top-projects'] }),
		'utf8'
	);
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();
	const result = mod.getStoredSettings().dashboardWidgets;
	expect(result).toEqual<WidgetPlacement[]>([
		{ id: 'kpi', width: 4, height: 2 },
		{ id: 'top-projects', width: 2, height: 3 }
	]);
});

test('resolveDashboardWidgets clamps a persisted v2 height below the widget minimum', async () => {
	const dir = tempDir();
	const file = join(dir, 'clamp-persisted.json');
	// Write a v2 file with a kpi height of 1 (below kpi's minHeight of 2).
	writeFileSync(
		file,
		JSON.stringify({
			version: 2,
			dashboardWidgets: [{ id: 'kpi', width: 4, height: 1 }]
		}),
		'utf8'
	);
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();
	const result = mod.resolveDashboardWidgets();
	expect(result).toHaveLength(1);
	expect(result[0].id).toBe('kpi');
	// Persisted height 1 is clamped up to kpi's minHeight of 2 on read.
	expect(result[0].height).toBe(2);
});

	test('the update path persists the clamped value (round-trip)', async () => {
		const dir = tempDir();
		const file = join(dir, 'clamp-rt.json');
		process.env.SETTINGS_FILE = file;
		const mod = await freshSettingsModule();

		// Write a kpi with height 1; the setter should clamp it to 2 before writing.
		mod.updateStoredSettings({
			dashboardWidgets: [{ id: 'kpi', width: 4, height: 1 }] as unknown as unknown[]
		});
		const readBack = mod.getStoredSettings().dashboardWidgets;
		expect(readBack).toHaveLength(1);
		expect(readBack![0].height).toBe(2);

		// Re-import to simulate a fresh process reading the same file.
		const mod2 = await freshSettingsModule();
		const reRead = mod2.getStoredSettings().dashboardWidgets;
		expect(reRead).toHaveLength(1);
		expect(reRead![0].height).toBe(2);
	});

/* ------------------------------------------------------------------ */
/* dashboardFilter normalisation & round-trip                           */
/* ------------------------------------------------------------------ */

test('normaliseDashboardFilter rejects a non-object', async () => {
	for (const value of [null, 'kpi', 42, ['7d'], true] as unknown[]) {
		const mod = await freshSettingsModule();
		expect(() => mod.normaliseDashboardFilter(value)).toThrow(/dashboardFilter must be a \{ period, scope \} object/);
	}
});

test('normaliseDashboardFilter rejects an unknown period', async () => {
	const mod = await freshSettingsModule();
	expect(() => mod.normaliseDashboardFilter({ period: 'forever', scope: null })).toThrow(
		/dashboardFilter\.period must be a known period preset/
	);
});

test('normaliseDashboardFilter rejects a non-string scope', async () => {
	const mod = await freshSettingsModule();
	expect(() => mod.normaliseDashboardFilter({ period: '7d', scope: 42 })).toThrow(
		/dashboardFilter\.scope must be a string or null/
	);
	expect(() => mod.normaliseDashboardFilter({ period: '7d', scope: undefined as unknown as string })).toThrow(
		/dashboardFilter\.scope must be a string or null/
	);
});

test('normaliseDashboardFilter rejects NUL in scope', async () => {
	const mod = await freshSettingsModule();
	expect(() => mod.normaliseDashboardFilter({ period: '7d', scope: '/evil\x00dir' })).toThrow(/NUL/i);
});

test('normaliseDashboardFilter rejects an oversized scope (>4096)', async () => {
	const mod = await freshSettingsModule();
	const long = '/a/'.repeat(2048); // > 4096 chars
	expect(() => mod.normaliseDashboardFilter({ period: '7d', scope: long })).toThrow(/at most 4096/i);
});

test('normaliseDashboardFilter normalises empty and "all" scope to null', async () => {
	const mod = await freshSettingsModule();
	expect(mod.normaliseDashboardFilter({ period: '7d', scope: '' })).toEqual({ period: '7d', scope: null });
	expect(mod.normaliseDashboardFilter({ period: '7d', scope: 'all' })).toEqual({ period: '7d', scope: null });
});

test('normaliseDashboardFilter preserves a non-empty known-scope string', async () => {
	const mod = await freshSettingsModule();
	const result = mod.normaliseDashboardFilter({ period: '30d', scope: '/repo/myproject' });
	expect(result).toEqual({ period: '30d', scope: '/repo/myproject' });
});

test('normaliseDashboardFilter accepts all valid period presets', async () => {
	const mod = await freshSettingsModule();
	for (const period of ['today', '3d', '7d', '30d', '90d', 'all'] as const) {
		const result = mod.normaliseDashboardFilter({ period, scope: null });
		expect(result.period).toBe(period);
	}
});

test('updateStoredSettings accepts dashboardFilter and persists it', async () => {
	const dir = tempDir();
	const file = join(dir, 'filter-rt.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	const next = mod.updateStoredSettings({
		dashboardFilter: { period: '30d', scope: '/repo/a' }
	});
	expect(next.dashboardFilter).toEqual({ period: '30d', scope: '/repo/a' });
	expect(mod.getStoredSettings().dashboardFilter).toEqual({ period: '30d', scope: '/repo/a' });
	expect(existsSync(file)).toBe(true);
	const disk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
	expect(disk).toHaveProperty('version', 2);
	expect((disk.dashboardFilter as { period: string; scope: string | null })).toEqual({
		period: '30d',
		scope: '/repo/a'
	});
});

test('null clears dashboardFilter; resolveDashboardFilter falls back to DEFAULT_FILTER', async () => {
	const dir = tempDir();
	const file = join(dir, 'filter-clear.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	mod.updateStoredSettings({ dashboardFilter: { period: '30d', scope: '/x' } });
	expect(mod.resolveDashboardFilter()).toEqual({ period: '30d', scope: '/x' });

	mod.updateStoredSettings({ dashboardFilter: null });
	expect(mod.getStoredSettings().dashboardFilter).toBeNull();
	// Cleared override -> default (7d / all).
	expect(mod.resolveDashboardFilter()).toEqual({ period: '7d', scope: null });
});

test('resolveDashboardFilter returns the stored pair when set', async () => {
	const dir = tempDir();
	const file = join(dir, 'filter-resolve.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	mod.updateStoredSettings({ dashboardFilter: { period: '90d', scope: '/mydir' } });
	expect(mod.resolveDashboardFilter()).toEqual({ period: '90d', scope: '/mydir' });
});

test('resolveDashboardFilter returns DEFAULT_FILTER when nothing is stored', async () => {
	const dir = tempDir();
	const file = join(dir, 'filter-default.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	expect(mod.resolveDashboardFilter()).toEqual({ period: '7d', scope: null });
});

test('hand-edited invalid dashboardFilter in the file degrades to default on read', async () => {
	const dir = tempDir();
	const file = join(dir, 'filter-bad.json');
	// Write a file with an invalid dashboardFilter (bad period).
	writeFileSync(
		file,
		JSON.stringify({ version: 2, dashboardFilter: { period: 'bogus', scope: '/x' } }),
		'utf8'
	);
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();
	// Invalid filter is ignored on read -> resolves to default.
	expect(mod.resolveDashboardFilter()).toEqual({ period: '7d', scope: null });
	// Stored settings does not carry the bad value.
	expect(mod.getStoredSettings().dashboardFilter).toBeUndefined();
});

test('dashboardFilter round-trips through PUT → GET unchanged', async () => {
	const dir = tempDir();
	const file = join(dir, 'filter-roundtrip.json');
	process.env.SETTINGS_FILE = file;
	const mod = await freshSettingsModule();

	const original = { period: '30d', scope: '/repo/b' };
	mod.updateStoredSettings({ dashboardFilter: original });
	const readBack = mod.getStoredSettings().dashboardFilter;
	expect(readBack).toEqual(original);
});
