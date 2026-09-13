import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Contract tests for the `GET /api/tracker/task/:id` ziptask proxy (modal
 * backend). No DB is touched; `globalThis.fetch` is stubbed and restored per
 * test, so the real network is never used.
 */

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-tracker-task-'));
const settingsFile = join(tempDir, 'settings.json');
process.env.SETTINGS_FILE = settingsFile;
process.env.ZIPTASK_BASE_URL = 'http://zt.test:3005/';
delete process.env.ZIPTASK_ENABLED;

function spec(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}

const route = (await import(spec('./[id]/+server.ts'))) as {
	GET: (event: { params: { id: string } }) => Promise<Response>;
};

const realFetch = globalThis.fetch;
const calls: string[] = [];

interface StubInit {
	status?: number;
	body?: unknown;
	throw?: Error;
}

function stubFetch(init: StubInit = {}): void {
	globalThis.fetch = ((input: RequestInfo | URL) => {
		calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		if (init.throw) return Promise.reject(init.throw);
		const status = init.status ?? 200;
		const payload = init.body === undefined ? { task: { id: 1, title: 'x' } } : init.body;
		return Promise.resolve(
			new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
				status,
				headers: { 'content-type': 'application/json' }
			})
		);
	}) as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
	calls.length = 0;
	process.env.ZIPTASK_BASE_URL = 'http://zt.test:3005/';
	delete process.env.ZIPTASK_ENABLED;
	process.env.SETTINGS_FILE = settingsFile;
});

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

const validTask = {
	id: 185,
	title: 'Ship the modal',
	description: 'Body',
	status: 'done',
	priority: 'p1',
	assignee: 'developer',
	reporter: 'orchestrator',
	attempts: 0,
	max_attempts: 3,
	created_at: '2026-09-13T05:36:28.320Z',
	updated_at: '2026-09-13T06:14:23.159Z',
	completed_at: '2026-09-13T06:14:23.159Z',
	is_epic: 0,
	epic_id: null
};

describe('GET /api/tracker/task/:id', () => {
	test('proxies the ziptask task and returns the normalised detail', async () => {
		stubFetch({
			body: {
				task: validTask,
				blocked_by: [],
				comments: [{ id: 1, agent: 'system', content: 'hi', type: 'comment', created_at: 't' }]
			}
		});
		const response = await route.GET({ params: { id: '185' } });
		expect(response.status).toBe(200);
		expect(calls).toEqual(['http://zt.test:3005/api/task/185']);
		const detail = (await response.json()) as { task: { id: number }; comments: unknown[] };
		expect(detail.task.id).toBe(185);
		expect(detail.comments).toHaveLength(1);
	});

	test('strips the configured base URL trailing slash', async () => {
		stubFetch();
		await route.GET({ params: { id: '7' } });
		expect(calls[0]).toBe('http://zt.test:3005/api/task/7');
	});

	test('percent-encodes a hostile id in the upstream path', async () => {
		stubFetch();
		await route.GET({ params: { id: 'a b/c?d#e' } });
		expect(calls[0]).toBe('http://zt.test:3005/api/task/a%20b%2Fc%3Fd%23e');
	});

	test('passes an upstream 404 through with its error message', async () => {
		stubFetch({ status: 404, body: { error: 'NOT_FOUND' } });
		const response = await route.GET({ params: { id: '999' } });
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'NOT_FOUND' });
	});

	test('passes an upstream 400 through (non-numeric id)', async () => {
		stubFetch({ status: 400, body: { error: 'Invalid task id' } });
		const response = await route.GET({ params: { id: 'abc' } });
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Invalid task id' });
	});

	test('maps an unexpected upstream status to 502', async () => {
		stubFetch({ status: 500, body: { error: 'boom' } });
		const response = await route.GET({ params: { id: '1' } });
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: 'boom' });
	});

	test('returns 502 for a non-task 200 payload', async () => {
		stubFetch({ body: { not: 'a task' } });
		const response = await route.GET({ params: { id: '1' } });
		expect(response.status).toBe(502);
	});

	test('returns 502 when ziptask is unreachable', async () => {
		stubFetch({ throw: new Error('connection refused') });
		const response = await route.GET({ params: { id: '1' } });
		expect(response.status).toBe(502);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain('connection refused');
	});

	test('returns 404 and never calls upstream when the integration is disabled', async () => {
		process.env.ZIPTASK_ENABLED = '0';
		stubFetch();
		const response = await route.GET({ params: { id: '1' } });
		expect(response.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test('returns 503 when enabled but the base URL is not configured', async () => {
		delete process.env.ZIPTASK_BASE_URL;
		process.env.ZIPTASK_ENABLED = '1';
		process.env.SETTINGS_FILE = join(tempDir, 'empty-settings.json');
		stubFetch();
		const response = await route.GET({ params: { id: '1' } });
		expect(response.status).toBe(503);
		expect(calls).toEqual([]);
	});
});
