/**
 * Dashboard widgets regression tests for the settings persistence layer (task #401).
 *
 * The `settings.suite.ts` already covers dbPath/ziptaskBaseUrl/agentsPath/
 * ziptaskEnabled round-trips; this suite extends the API contract with
 * `dashboardWidgets` validation, dedup, unknown-drop, registry-ordering and the
 * malformed-input rejection that must leave the file byte-identical.
 *
 * Runs in an isolated child process (see `settings-dashboard.test.ts`) so the
 * suite owns a clean `$lib/server/settings` module graph without pollution from
 * the health test's `mock.module('$lib/server/db', ...)`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-settings-dashboard-'));
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

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* PUT /api/settings — dashboardWidgets validation & round-trip       */
/* ------------------------------------------------------------------ */

describe('PUT /api/settings — dashboardWidgets', () => {
	test('absent dashboardWidgets in body → defaults (6 widgets) on GET', async () => {
		if (existsSync(SETTINGS_FILE)) rmSync(SETTINGS_FILE, { force: true });
		const putResp = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dbPath: '/tmp/empty.db' })
			})
		});
		expect(putResp.status).toBe(200);

		const getResp = settingsRoute.GET({});
		expect(getResp.status).toBe(200);
		const body = (await getResp.json()) as Record<string, unknown>;
		const stored = body.stored as Record<string, unknown>;
		expect(stored.dashboardWidgets).toBeNull();
		const source = body.source as Record<string, unknown>;
		expect(source.dashboardWidgets).toBe('default');
		// The effective payload should have 6 default widget ids.
		expect((body.dashboardWidgets as string[] | null)).toHaveLength(6);
	});

	test('empty array [] → [] effective, stored stays null (no explicit empty persist)', async () => {
		if (existsSync(SETTINGS_FILE)) rmSync(SETTINGS_FILE, { force: true });
		const putResp = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dashboardWidgets: [] })
			})
		});
		expect(putResp.status).toBe(200);
		const body = (await putResp.json()) as Record<string, unknown>;
		// PUT returns the validated list; an empty valid list stays empty.
		expect(body.dashboardWidgets).toEqual([]);
		const stored = body.stored as Record<string, unknown>;
		// Stored reflects the validated empty list (not null = not-default).
		expect(stored.dashboardWidgets).toEqual([]);
		const source = body.source as Record<string, unknown>;
		expect(source.dashboardWidgets).toBe('file');
	});

	test('unknown ids are dropped, known ids preserved in registry order', async () => {
		if (existsSync(SETTINGS_FILE)) rmSync(SETTINGS_FILE, { force: true });
		const putResp = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dashboardWidgets: ['top-tools', 'kpi', 'ghost'] })
			})
		});
		expect(putResp.status).toBe(200);
		const body = (await putResp.json()) as Record<string, unknown>;
		expect(body.dashboardWidgets).toEqual(['kpi', 'top-tools']); // registry order
	});

	test('duplicates collapse to a single entry', async () => {
		if (existsSync(SETTINGS_FILE)) rmSync(SETTINGS_FILE, { force: true });
		const putResp = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dashboardWidgets: ['kpi', 'kpi', 'kpi'] })
			})
		});
		expect(putResp.status).toBe(200);
		const body = (await putResp.json()) as Record<string, unknown>;
		expect(body.dashboardWidgets).toEqual(['kpi']);
	});

	test('input reordered → output re-ordered to registry order', async () => {
		if (existsSync(SETTINGS_FILE)) rmSync(SETTINGS_FILE, { force: true });
		const putResp = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dashboardWidgets: ['top-tools', 'agent-distribution', 'sessions-per-day'] })
			})
		});
		expect(putResp.status).toBe(200);
		const body = (await putResp.json()) as Record<string, unknown>;
		// Registry order: kpi, sessions-per-day, cost-per-day, top-tools, agent-distribution, top-projects.
		expect(body.dashboardWidgets).toEqual(['sessions-per-day', 'top-tools', 'agent-distribution']);
	});

	test('non-array value → 400 {error, field: "dashboardWidgets"}', async () => {
		// `null` is deliberately absent: it is the "clear" signal (200), covered separately.
		for (const payload of [
			{ dashboardWidgets: 'kpi' },
			{ dashboardWidgets: 42 },
			{ dashboardWidgets: { id: 'kpi' } }
		] as Record<string, unknown>[]) {
			const putResp = await settingsRoute.PUT({
				request: new Request('http://localhost/api/settings', {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload)
				})
			});
			expect(putResp.status).toBe(400);
			const body = (await putResp.json()) as { error: string; field?: string };
			expect(body.field).toBe('dashboardWidgets');
		}
	});

	test('non-string entry in array → 400 {error, field: "dashboardWidgets"}', async () => {
		const putResp = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dashboardWidgets: ['kpi', 42] })
			})
		});
		expect(putResp.status).toBe(400);
		const body = (await putResp.json()) as { error: string; field?: string };
		expect(body.field).toBe('dashboardWidgets');
	});

	test('>MAX_DASHBOARD_WIDGETS (24) entries → 400', async () => {
		const tooMany = Array.from({ length: 25 }, (_, i) => `widget-${i}`);
		const putResp = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dashboardWidgets: tooMany })
			})
		});
		expect(putResp.status).toBe(400);
		const body = (await putResp.json()) as { error: string; field?: string };
		expect(body.field).toBe('dashboardWidgets');
	});

	test('malformed input does NOT corrupt the existing settings file', async () => {
		if (existsSync(SETTINGS_FILE)) rmSync(SETTINGS_FILE, { force: true });
		// Seed a valid state.
		await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dashboardWidgets: ['kpi'] })
			})
		});
		const before = readFileSync(SETTINGS_FILE, 'utf8').trim();

		// Now send malformed input.
		const putResp = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dashboardWidgets: 42 })
			})
		});
		expect(putResp.status).toBe(400);
		// File must be byte-identical — no partial write.
		expect(readFileSync(SETTINGS_FILE, 'utf8').trim()).toBe(before);
	});

	test('null clears dashboardWidgets; GET falls back to defaults', async () => {
		if (existsSync(SETTINGS_FILE)) rmSync(SETTINGS_FILE, { force: true });
		await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dashboardWidgets: ['kpi'] })
			})
		});
		const putClear = await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dashboardWidgets: null })
			})
		});
		expect(putClear.status).toBe(200);
		const body = (await putClear.json()) as Record<string, unknown>;
		expect((body.stored as { dashboardWidgets: unknown }).dashboardWidgets).toBeNull();
		// Subsequent GET: source = default, effective = DEFAULT_WIDGETS (6 ids).
		const getResp = settingsRoute.GET({});
		expect(getResp.status).toBe(200);
		const getBody = (await getResp.json()) as Record<string, unknown>;
		expect((getBody.source as { dashboardWidgets: unknown }).dashboardWidgets).toBe('default');
		expect(getBody.dashboardWidgets).toHaveLength(6);
	});

	test('on-disk shape: version:1 + dashboardWidgets key present after PUT', async () => {
		if (existsSync(SETTINGS_FILE)) rmSync(SETTINGS_FILE, { force: true });
		await settingsRoute.PUT({
			request: new Request('http://localhost/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ dashboardWidgets: ['kpi', 'top-tools'] })
			})
		});
		const disk = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>;
		expect(disk.version).toBe(1);
		expect(disk.dashboardWidgets).toEqual(['kpi', 'top-tools']);
	});

	test('hand-edited invalid list in the file degrades to defaults on read', async () => {
		const dir = join(tempDir, 'degrade');
		mkdirSync(dir, { recursive: true });
		const badFile = join(dir, 'settings.json');
		// Write a file with an invalid dashboardWidgets (integer entry).
		writeFileSync(
			badFile,
			JSON.stringify({ version: 1, dashboardWidgets: ['kpi', 42] }),
			'utf8'
		);
		// Point the suite at this file.
		const orig = process.env.SETTINGS_FILE;
		process.env.SETTINGS_FILE = badFile;
		try {
			// Re-import the route module with cache-busted specifier so it re-reads the file.
			const freshRoute = (await import(spec('./+server.ts') + '?bust=' + crypto.randomUUID())) as {
				GET: (event: unknown) => Response;
			};
			const resp = freshRoute.GET({});
			expect(resp.status).toBe(200);
			const body = (await resp.json()) as Record<string, unknown>;
			// Invalid dashboardWidgets in the file is ignored → defaults.
			const src = body.source as Record<string, unknown>;
			expect(src.dashboardWidgets).toBe('default');
			expect((body.dashboardWidgets as string[] | null)).toHaveLength(6);
		} finally {
			if (orig === undefined) delete process.env.SETTINGS_FILE;
			else process.env.SETTINGS_FILE = orig;
		}
	});

	test('GET echo shape: dashboardWidgets string[] / stored source enum', async () => {
		if (existsSync(SETTINGS_FILE)) rmSync(SETTINGS_FILE, { force: true });
		const resp = settingsRoute.GET({});
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as Record<string, unknown>;
		expect(Array.isArray(body.dashboardWidgets)).toBe(true);
		for (const id of body.dashboardWidgets as string[]) {
			expect(typeof id).toBe('string');
		}
		expect((body.stored as Record<string, unknown>).dashboardWidgets).toBeNull();
		expect((body.source as Record<string, unknown>).dashboardWidgets).toBe('default');
	});
});
