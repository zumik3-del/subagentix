/**
 * M3a DB-unavailable suite (task #188, ADR §4.1 / §4.5 / R2).
 *
 * Runs as an isolated child process (see `data-layer.suite.ts` for why) with
 * `OPENCODE_DB` pointed at a path that does not exist. Asserts every API route
 * returns a clear 503 JSON error, the session page `load()` throws a 503
 * HttpError, the layout loader falls back to `{ sidebar: null }` so the shell
 * still renders (task #215 removed the home `+page.server.ts`), and — critically
 * — no code path falls back to a mutating open (which would create the file).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { isHttpError } from '@sveltejs/kit';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-m3a-missing-'));
const MISSING = join(tempDir, 'missing.db');
process.env.OPENCODE_DB = MISSING;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');

function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const listRoute = (await import(spec('./+server.ts'))) as {
	GET: (event: { url: URL }) => Response;
};
const directoriesRoute = (await import(spec('../directories/+server.ts'))) as {
	GET: (event?: unknown) => Response;
};
const detailRoute = (await import(spec('./[id]/+server.ts'))) as {
	GET: (event: { params: { id: string } }) => Response;
};
const turnRoute = (await import(spec('./[id]/turns/[turnId]/+server.ts'))) as {
	GET: (event: { params: { id: string; turnId: string } }) => Response;
};
const nodeRoute = (await import(spec('./[id]/nodes/[nodeId]/+server.ts'))) as {
	GET: (event: { params: { id: string; nodeId: string }; url: URL }) => Response;
};
const layoutPage = (await import(spec('../../+layout.server.ts'))) as {
	load: () => unknown;
};
const detailPage = (await import(spec('../../sessions/[id]/+page.server.ts'))) as {
	load: (event: { params: { id: string }; url?: URL }) => unknown;
};
const { resolveDbPath } = await import(spec('../../../lib/server/db.ts'));

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function expect503(response: Response, message = 'not found'): Promise<void> | void {
	expect(response.status).toBe(503);
	return response
		.json()
		.then((payload: { error?: unknown }) => {
			expect(typeof payload.error).toBe('string');
			expect(payload.error as string).toContain(message);
		});
}

function expectHttp503(fn: () => unknown): void {
	try {
		fn();
		throw new Error('expected load() to throw');
	} catch (error) {
		expect(isHttpError(error)).toBe(true);
		expect((error as { status: number }).status).toBe(503);
		expect((error as { body: { message: string } }).body.message).toContain('not found');
	}
}

describe('DB unavailable (OPENCODE_DB points at a missing file)', () => {
	test('the data layer resolves the missing path and throws, it does not create it', () => {
		expect(resolveDbPath()).toBe(MISSING);
		expect(existsSync(MISSING)).toBe(false);
	});

	test('GET /api/sessions -> 503 JSON', async () => {
		await expect503(listRoute.GET({ url: new URL('http://localhost/api/sessions') }));
	});

	test('GET /api/directories -> 503 JSON', async () => {
		await expect503(directoriesRoute.GET());
	});

	test('GET /api/sessions/[id] -> 503 JSON', async () => {
		await expect503(detailRoute.GET({ params: { id: 'root1' } }));
	});

	test('GET /api/sessions/[id]/turns/[turnId] -> 503 JSON', async () => {
		await expect503(turnRoute.GET({ params: { id: 'root1', turnId: 'u1' } }));
	});

	test('GET /api/sessions/[id]/nodes/[nodeId] -> 503 JSON', async () => {
		await expect503(
			nodeRoute.GET({
				params: { id: 'root1', nodeId: 'child1' },
				url: new URL('http://localhost/api/sessions/root1/nodes/child1?turn=u1')
			})
		);
	});

	test('layout load falls back to { sidebar: null } so the shell still renders', () => {
		// Task #215 removed the home `+page.server.ts`, so `/` has no DB access;
		// the layout must swallow its own failure and ship a null sidebar.
		expect(layoutPage.load()).toEqual({ sidebar: null });
	});

	test('/sessions/[id] page load throws a 503 HttpError with the data-layer message', () => {
		expectHttp503(() => detailPage.load({ params: { id: 'root1' } }));
	});

	test('/sessions/[id]?turn= page load also throws a 503 HttpError (Gantt path)', () => {
		expectHttp503(() =>
			detailPage.load({
				params: { id: 'root1' },
				url: new URL('http://localhost/sessions/root1?turn=u1')
			})
		);
	});

	test('no mutating-open fallback: the missing DB file is still absent', () => {
		expect(existsSync(MISSING)).toBe(false);
	});
});
