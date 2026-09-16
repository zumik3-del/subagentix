/**
 * Settings API suite (task #257, ADR §6).
 *
 * Runs in an isolated child process (see `settings.test.ts`) so the suite
 * owns a clean `$lib/server/db` / `$lib/server/settings` module graph without
 * pollution from the health test's `mock.module('$lib/server/db', ...)`.
 *
 * Every scenario isolates `SETTINGS_FILE` to a throwaway temp path. Two
 * opencode-shaped fixtures live under the OS temp dir; the live opencode DB is
 * never touched.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-settings-api-'));
const SETTINGS_FILE = join(tempDir, 'settings.json');
process.env.SETTINGS_FILE = SETTINGS_FILE;
delete process.env.OPENCODE_DB;
delete process.env.ZIPTASK_BASE_URL;
delete process.env.ZIPTASK_ENABLED;
delete process.env.STATE_DIRECTORY;

function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const settingsRoute = (await import(spec('./+server.ts'))) as {
	GET: (event: unknown) => Response;
	PUT: (event: { request: Request }) => Promise<Response>;
};
const discoverOpencodeRoute = (await import(spec('./discover/opencode/+server.ts'))) as {
	POST: (event: { request: Request }) => Promise<Response>;
};
const discoverZiptaskRoute = (await import(spec('./discover/ziptask/+server.ts'))) as {
	POST: (event: unknown) => Promise<Response>;
};
const discoverAgentsRoute = (await import(spec('./discover/agents/+server.ts'))) as {
	POST: (event: unknown) => Promise<Response>;
};

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* GET /api/settings                                                  */
/* ------------------------------------------------------------------ */

describe('GET /api/settings', () => {
	test('defaults shape: all values from env/default, source reflects that', async () => {
		// Ensure the settings file does not exist so the store starts empty.
		if (existsSync(SETTINGS_FILE)) rmSync(SETTINGS_FILE, { force: true });
		const response = settingsRoute.GET({});
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(typeof body.dbPath).toBe('string');
		expect(body.ziptaskBaseUrl).toBeNull();
		expect(body.ziptaskEnabled).toBe(false);
		expect(body.agentsPath).toBeNull();
		expect(body.stored).toEqual({
			dbPath: null,
			ziptaskBaseUrl: null,
			ziptaskEnabled: null,
			agentsPath: null,
			dashboardWidgets: null
		});
		expect(body.source).toEqual({
			dbPath: 'default',
			ziptaskBaseUrl: 'none',
			ziptaskEnabled: 'default',
			agentsPath: 'none',
			dashboardWidgets: 'default'
		});
	});

	test('file source appears after a successful PUT (no direct file writes)', async () => {
		// Use the PUT route to seed the settings file — this updates the in-memory
		// cache so the subsequent GET sees the new value.
		const putResp = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dbPath: '/tmp/seeded.db' })
			})
		});
		expect(putResp.status).toBe(200);

		const response = settingsRoute.GET({});
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.dbPath).toBe('/tmp/seeded.db');
		expect(body.stored).toEqual({
			dbPath: '/tmp/seeded.db',
			ziptaskBaseUrl: null,
			ziptaskEnabled: null,
			agentsPath: null,
			dashboardWidgets: null
		});
		expect(body.source).toEqual({
			dbPath: 'file',
			ziptaskBaseUrl: 'none',
			ziptaskEnabled: 'default',
			agentsPath: 'none',
			dashboardWidgets: 'default'
		});
	});
});

/* ------------------------------------------------------------------ */
/* PUT /api/settings                                                  */
/* ------------------------------------------------------------------ */

describe('PUT /api/settings', () => {
	test('valid partial update persists and changes effective values', async () => {
		if (existsSync(SETTINGS_FILE)) rmSync(SETTINGS_FILE, { force: true });
		const response = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dbPath: '/tmp/partial.db' })
			})
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { dbPath: string; stored: { dbPath: string | null; ziptaskBaseUrl: string | null } };
		expect(body.dbPath).toBe('/tmp/partial.db');
		expect(body.stored.dbPath).toBe('/tmp/partial.db');
		// File on disk reflects the write.
		expect(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8').trim())).toMatchObject({
			version: 2,
			dbPath: '/tmp/partial.db'
		});
	});

	test('null clears a key; absent key is unchanged', async () => {
		// Start with both keys set via PUT.
		await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dbPath: '/tmp/a.db', ziptaskBaseUrl: 'http://x:1' })
			})
		});
		// Clear only dbPath.
		const response = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dbPath: null })
			})
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { dbPath: string; stored: { dbPath: string | null; ziptaskBaseUrl: string | null } };
		// dbPath falls back to default (no env override).
		expect(body.dbPath).toBe('/home/opencode/.local/share/opencode/opencode.db');
		expect(body.stored.dbPath).toBeNull();
		// ziptaskBaseUrl was NOT in the patch -> unchanged.
		expect(body.stored.ziptaskBaseUrl).toBe('http://x:1');
	});

	test('invalid dbPath → 400 {error, field}', async () => {
		for (const payload of [
			{ dbPath: 'relative' },
			{ dbPath: '' },
			{ dbPath: '/tmp/\x00evil.db' },
			{ dbPath: 'a'.repeat(5000) }
		] as Record<string, unknown>[]) {
			const response = await settingsRoute.PUT({
				request: new Request('http://localhost/api/settings', {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload)
				})
			});
			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string; field?: string };
			expect(typeof body.error).toBe('string');
			expect(body.field).toBe('dbPath');
		}
	});

	test('valid agentsPath persists and is echoed by the payload', async () => {
		if (existsSync(SETTINGS_FILE)) rmSync(SETTINGS_FILE, { force: true });
		const response = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agentsPath: '/tmp/agents' })
			})
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			agentsPath: string;
			stored: { agentsPath: string | null };
			source: { agentsPath: string };
		};
		expect(body.agentsPath).toBe('/tmp/agents');
		expect(body.stored.agentsPath).toBe('/tmp/agents');
		expect(body.source.agentsPath).toBe('file');
	});

	test('invalid agentsPath → 400 {error, field}', async () => {
		for (const payload of [
			{ agentsPath: 'relative' },
			{ agentsPath: '' },
			{ agentsPath: '/tmp/\x00evil' }
		] as Record<string, unknown>[]) {
			const response = await settingsRoute.PUT({
				request: new Request('http://localhost/api/settings', {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload)
				})
			});
			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string; field?: string };
			expect(typeof body.error).toBe('string');
			expect(body.field).toBe('agentsPath');
		}
	});

	test('invalid ziptaskBaseUrl → 400 {error, field}', async () => {
		for (const payload of [
			{ ziptaskBaseUrl: 'ftp://host' },
			{ ziptaskBaseUrl: 'http://user:pass@host' },
			{ ziptaskBaseUrl: '' },
			{ ziptaskBaseUrl: 'not-a-url' }
		] as Record<string, unknown>[]) {
			const response = await settingsRoute.PUT({
				request: new Request('http://localhost/api/settings', {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload)
				})
			});
			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string; field?: string };
			expect(body.field).toBe('ziptaskBaseUrl');
		}
	});

	test('ziptaskEnabled persists and is echoed with file source', async () => {
		if (existsSync(SETTINGS_FILE)) rmSync(SETTINGS_FILE, { force: true });
		const response = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ziptaskEnabled: false })
			})
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ziptaskEnabled: boolean;
			stored: { ziptaskEnabled: boolean | null };
			source: { ziptaskEnabled: string };
		};
		expect(body.ziptaskEnabled).toBe(false);
		expect(body.stored.ziptaskEnabled).toBe(false);
		expect(body.source.ziptaskEnabled).toBe('file');
	});

	test('ZIPTASK_ENABLED env supplies the default when no stored override exists', async () => {
		// Clear any stored override from a previous test via the API so the
		// in-memory cache reflects the change (an out-of-band file delete would
		// not invalidate the cache).
		await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ziptaskEnabled: null })
			})
		});
		process.env.ZIPTASK_ENABLED = '1';
		try {
			const body = (await settingsRoute.GET({}).json()) as {
				ziptaskEnabled: boolean;
				source: { ziptaskEnabled: string };
			};
			expect(body.ziptaskEnabled).toBe(true);
			expect(body.source.ziptaskEnabled).toBe('env');
		} finally {
			delete process.env.ZIPTASK_ENABLED;
		}
	});

	test('invalid ziptaskEnabled → 400 {error, field}', async () => {
		for (const payload of [{ ziptaskEnabled: 'yes' }, { ziptaskEnabled: 1 }, { ziptaskEnabled: {} }] as Record<
			string,
			unknown
		>[]) {
			const response = await settingsRoute.PUT({
				request: new Request('http://localhost/api/settings', {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload)
				})
			});
			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string; field?: string };
			expect(body.field).toBe('ziptaskEnabled');
		}
	});

	test('non-JSON body returns 400', async () => {
		const response = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: 'not-json'
			})
		});
		expect(response.status).toBe(400);
	});
});

/* ------------------------------------------------------------------ */
/* Live apply across two DB fixtures                                  */
/* ------------------------------------------------------------------ */

/** Build a minimal opencode-shaped fixture under `dir`. */
function buildFixture(dir: string, sessions = 3): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'fixture.db');
	const db = new Database(path);
	db.exec(`
		CREATE TABLE session (id TEXT PRIMARY KEY);
		CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
		CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
	`);
	const ins = db.prepare('INSERT INTO session (id) VALUES (?)');
	for (let i = 0; i < sessions; i++) ins.run(`s${i}`);
	db.close();
	return path;
}

describe('live apply: PUT swaps the effective DB path', () => {
	const applyDir = mkdtempSync(join(tmpdir(), 'subagentix-settings-live-'));
	const first = buildFixture(join(applyDir, 'first'), 2);
	const second = buildFixture(join(applyDir, 'second'), 5);

	afterAll(() => {
		rmSync(applyDir, { recursive: true, force: true });
	});

	test('first fixture is read via healthCheck()', async () => {
		// Seed the settings file via PUT so the in-memory cache is warmed.
		const putResp = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dbPath: first })
			})
		});
		expect(putResp.status).toBe(200);

		const { healthCheck } = (await import(
			spec('../../../lib/server/db.ts')
		)) as { healthCheck: () => { ok: true; dbPath: string; sessions: number } };
		const report = healthCheck();
		expect(report.dbPath).toBe(first);
		expect(report.sessions).toBe(2);
	});

	test('after PUT to the second path, healthCheck reports the new path + count', async () => {
		const putResp = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dbPath: second })
			})
		});
		expect(putResp.status).toBe(200);

		const { healthCheck } = (await import(
			spec('../../../lib/server/db.ts')
		)) as { healthCheck: () => { ok: true; dbPath: string; sessions: number } };
		const report = healthCheck();
		expect(report.dbPath).toBe(second);
		expect(report.sessions).toBe(5);
	});
});

/* ------------------------------------------------------------------ */
/* Discovery routes                                                    */
/* ------------------------------------------------------------------ */

describe('POST /api/settings/discover/opencode', () => {
	test('returns 200 with { candidates, recommended } shape', async () => {
		const response = await discoverOpencodeRoute.POST({
			request: new Request('http://localhost/api/settings/discover/opencode', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			})
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			candidates: Array<{ path: string; sessions: number; mtimeMs: number }>;
			recommended: string | null;
		};
		expect(Array.isArray(body.candidates)).toBe(true);
		expect(body.recommended === null || typeof body.recommended === 'string').toBe(true);
	});

	test('extraPath in body is validated (must be absolute)', async () => {
		const response = await discoverOpencodeRoute.POST({
			request: new Request('http://localhost/api/settings/discover/opencode', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ extraPath: 'relative' })
			})
		});
		expect(response.status).toBe(400);
	});

	test('not-found degrades to empty candidates without throwing when no real DB exists', async () => {
		// Point the opencode candidate search away from the real home dir.
		const fakeHome = join(tempDir, 'fake-home');
		mkdirSync(fakeHome, { recursive: true });
		// Override HOME so the discovery scan looks in our temp tree, not /home/opencode.
		const origHome = process.env.HOME;
		process.env.HOME = fakeHome;
		delete process.env.XDG_DATA_HOME;
		delete process.env.OPENCODE_DB;

		try {
			const response = await discoverOpencodeRoute.POST({
				request: new Request('http://localhost/api/settings/discover/opencode', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{}'
				})
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as { candidates: unknown[]; recommended: unknown };
			expect(body.candidates).toEqual([]);
			expect(body.recommended).toBeNull();
		} finally {
			if (origHome === undefined) delete process.env.HOME;
			else process.env.HOME = origHome;
		}
	});
});

describe('POST /api/settings/discover/ziptask', () => {
	test('returns 200 with { candidates, recommended } shape', async () => {
		const response = await discoverZiptaskRoute.POST({});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			candidates: Array<{ baseUrl: string; source: string }>;
			recommended: string | null;
		};
		expect(Array.isArray(body.candidates)).toBe(true);
	});
});

describe('POST /api/settings/discover/agents', () => {
	test('returns 200 with { candidates, recommended } shape', async () => {
		const response = await discoverAgentsRoute.POST({});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			candidates: Array<{ path: string; agentCount: number }>;
			recommended: string | null;
		};
		expect(Array.isArray(body.candidates)).toBe(true);
		expect(body.recommended === null || typeof body.recommended === 'string').toBe(true);
	});
});

/* ------------------------------------------------------------------ */
/* Server-only leak guard                                             */
/* ------------------------------------------------------------------ */

describe('SettingsModal server-only leak guard', () => {
	test('SettingsModal.svelte has no $lib/server / bun:sqlite / opencode.db / OPENCODE_DB imports', () => {
		const modal = readFileSync(
			join(__dirname, '../../../../src/lib/components/features/settings/SettingsModal.svelte'),
			'utf8'
		);
		const imports = modal
			.split('\n')
			.filter((line) => /^\s*import\b/.test(line))
			.join('\n');
		expect(imports).not.toMatch(/\$lib\/server|bun:sqlite|opencode\.db|OPENCODE_DB/);
	});
});
