import { describe, expect, test } from 'bun:test';
import { buildToolErrorsUrl, appendToolErrorRows, TOOL_ERRORS_ENDPOINT } from './tool-errors';
import type { ToolErrorEntry } from '$lib/model/tool-errors';

describe('TOOL_ERRORS_ENDPOINT', () => {
	test('exports the expected path', () => {
		expect(TOOL_ERRORS_ENDPOINT).toBe('/api/dashboard/tool-errors');
	});
});

describe('buildToolErrorsUrl()', () => {
	const base = {
		status: 'errors' as const,
		tool: '',
		period: '30d' as const,
		scope: null as string | null,
		agent: '',
		search: ''
	};

	test('includes status, period, scope=all, limit and offset', () => {
		const url = buildToolErrorsUrl(base, 50, 0);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.get('status')).toBe('errors');
		expect(params.get('period')).toBe('30d');
		expect(params.get('scope')).toBe('all');
		expect(params.get('limit')).toBe('50');
		expect(params.get('offset')).toBe('0');
	});

	test('includes the scoped directory when scope is non-null', () => {
		const filters = { ...base, scope: '/repo/a' };
		const url = buildToolErrorsUrl(filters, 10, 20);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.get('scope')).toBe('/repo/a');
		expect(params.get('limit')).toBe('10');
		expect(params.get('offset')).toBe('20');
	});

	test('trailing tool/agent/search are omitted when blank', () => {
		const url = buildToolErrorsUrl(base, 50, 0);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.has('tool')).toBe(false);
		expect(params.has('agent')).toBe(false);
		expect(params.has('q')).toBe(false);
	});

	test('non-blank tool is included as ?tool=', () => {
		const url = buildToolErrorsUrl({ ...base, tool: 'bash' }, 50, 0);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.get('tool')).toBe('bash');
	});

	test('non-blank agent is included as ?agent=', () => {
		const url = buildToolErrorsUrl({ ...base, agent: 'build' }, 50, 0);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.get('agent')).toBe('build');
	});

	test('non-blank search is included as ?q=', () => {
		const url = buildToolErrorsUrl({ ...base, search: 'boom' }, 50, 0);
		const params = new URLSearchParams(url.split('?')[1]);
		expect(params.get('q')).toBe('boom');
	});

	test('tool with spaces is encoded by URLSearchParams', () => {
		const url = buildToolErrorsUrl({ ...base, tool: 'my tool' }, 50, 0);
		expect(url).toContain('tool=my+tool');
	});

	test('search with special chars is encoded', () => {
		const url = buildToolErrorsUrl({ ...base, search: 'a&b=c' }, 50, 0);
		expect(url).toContain('q=a%26b%3Dc');
	});

	test('base path is preserved', () => {
		const url = buildToolErrorsUrl(base, 50, 0);
		expect(url.startsWith(`${TOOL_ERRORS_ENDPOINT}?`)).toBe(true);
	});
});

describe('appendToolErrorRows()', () => {
	test('appends new rows to existing rows', () => {
		const existing: ToolErrorEntry[] = [
			{ id: 'r1', sessionId: 's1', at: 200, agent: 'a', tool: 't', status: 'error', error: 'e1' },
			{ id: 'r2', sessionId: 's1', at: 100, agent: 'a', tool: 't', status: 'failed', error: 'e2' }
		];
		const page = { rows: [
			{ id: 'r3', sessionId: 's1', at: 300, agent: 'a', tool: 't', status: 'error', error: 'e3' }
		]};
		const result = appendToolErrorRows(existing, page);
		expect(result).toHaveLength(3);
		expect(result[0].id).toBe('r1');
		expect(result[1].id).toBe('r2');
		expect(result[2].id).toBe('r3');
	});

	test('empty existing array returns just the new rows', () => {
		const page = { rows: [
			{ id: 'r1', sessionId: 's1', at: 100, agent: 'a', tool: 't', status: 'error', error: 'e' }
		]};
		expect(appendToolErrorRows([], page)).toHaveLength(1);
		expect(appendToolErrorRows([], page)[0].id).toBe('r1');
	});

	test('empty page rows leaves existing unchanged', () => {
		const existing: ToolErrorEntry[] = [
			{ id: 'r1', sessionId: 's1', at: 100, agent: 'a', tool: 't', status: 'error', error: 'e' }
		];
		expect(appendToolErrorRows(existing, { rows: [] })).toEqual(existing);
	});
});

describe('tool-errors.ts stays DOM-free and server-free', () => {
	test('does not import $lib/server, Svelte or the DOM', async () => {
		const source = new URL('./tool-errors.ts', import.meta.url);
		const content = await Bun.file(source).text();
		expect(content).not.toMatch(/from ['"]\$lib\/server/);
		expect(content).not.toMatch(/from ['"]svelte/);
		expect(content).not.toMatch(/\bdocument\.|\bwindow\./);
	});
});
