import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	DETAIL_DEFS,
	TOOL_ERRORS_PARAM,
	TOOL_CALLS_PARAM,
	detailTargetFor,
	type DetailKind,
	type DetailTarget
} from './detail';
import type { ToolCallStatus } from '$lib/model/tool-errors';

/**
 * Unit tests for the detail overlay registry (dashboard widget engine, task #492).
 *
 * Pins the contract between DetailTarget, DETAIL_DEFS and the URL query params,
 * so a regression that drifts a param name or drops a kind surfaces here.
 */

describe('detailTargetFor()', () => {
	test('maps mode=errors to kind=tool-errors', () => {
		const target = detailTargetFor('bash', 'errors');
		expect(target).toEqual({ kind: 'tool-errors', tool: 'bash', mode: 'errors' });
	});

	test('maps mode=all to kind=tool-calls', () => {
		const target = detailTargetFor('bash', 'all');
		expect(target).toEqual({ kind: 'tool-calls', tool: 'bash', mode: 'all' });
	});

	test('preserves the tool name verbatim', () => {
		const target = detailTargetFor('read-file', 'errors');
		expect(target.tool).toBe('read-file');
	});

	test('handles tools with spaces', () => {
		const target = detailTargetFor('my tool', 'all');
		expect(target.tool).toBe('my tool');
		expect(target.kind).toBe('tool-calls');
	});
});

describe('DETAIL_DEFS', () => {
	test('covers exactly the two DetailKind values', () => {
		const kinds = Object.keys(DETAIL_DEFS) as DetailKind[];
		expect(kinds).toContain('tool-errors');
		expect(kinds).toContain('tool-calls');
		expect(kinds).toHaveLength(2);
	});

	test('tool-errors param is "toolErrors"', () => {
		expect(DETAIL_DEFS['tool-errors'].param).toBe('toolErrors');
	});

	test('tool-calls param is "toolCalls"', () => {
		expect(DETAIL_DEFS['tool-calls'].param).toBe('toolCalls');
	});

	test('each def carries a non-empty title', () => {
		for (const kind of ['tool-errors', 'tool-calls'] as const) {
			expect(DETAIL_DEFS[kind].title.length).toBeGreaterThan(0);
		}
	});

	test('each def carries a load function', () => {
		for (const kind of ['tool-errors', 'tool-calls'] as const) {
			expect(typeof DETAIL_DEFS[kind].load).toBe('function');
		}
	});

	test('both kinds load the same component (ToolErrorsModal)', async () => {
		const [errorsMod, callsMod] = await Promise.all([
			DETAIL_DEFS['tool-errors'].load(),
			DETAIL_DEFS['tool-calls'].load()
		]);
		expect(errorsMod.default).toBe(callsMod.default);
	});
});

describe('URL param constants', () => {
	test('TOOL_ERRORS_PARAM matches DETAIL_DEFS["tool-errors"].param', () => {
		expect(TOOL_ERRORS_PARAM).toBe('toolErrors');
	});

	test('TOOL_CALLS_PARAM matches DETAIL_DEFS["tool-calls"].param', () => {
		expect(TOOL_CALLS_PARAM).toBe('toolCalls');
	});
});

describe('DetailTarget type exhaustiveness', () => {
	test('every DetailKind has a corresponding DETAIL_DEFS entry', () => {
		const knownKinds = new Set(Object.keys(DETAIL_DEFS) as DetailKind[]);
		// The DetailTarget union has two literal kinds; both must appear in the registry.
		expect(knownKinds).toContain('tool-errors');
		expect(knownKinds).toContain('tool-calls');
	});

	test('a DetailTarget can be matched against DETAIL_DEFS by its kind', () => {
		const targets: DetailTarget[] = [
			{ kind: 'tool-errors', tool: 'bash', mode: 'errors' },
			{ kind: 'tool-calls', tool: 'bash', mode: 'all' }
		];
		for (const target of targets) {
			expect(DETAIL_DEFS[target.kind]).toBeDefined();
			expect(typeof DETAIL_DEFS[target.kind].param).toBe('string');
		}
	});
});

describe('detail.ts stays client-safe and SSR-safe', () => {
	const source = readFileSync(new URL('./detail.ts', import.meta.url), 'utf8');

	test('does not import $lib/server or bun:sqlite', () => {
		expect(source).not.toMatch(/from ['"]\$lib\/server/);
		expect(source).not.toMatch(/from ['"]bun:sqlite/);
	});

	test('imports Svelte context API (expected)', () => {
		// The module intentionally uses Svelte's getContext/setContext — this is
		// the supported pattern for cross-component communication without prop drilling.
		expect(source).toMatch(/from ['"]svelte['"]/);
	});

	test('does not access the DOM directly', () => {
		expect(source).not.toMatch(/\bdocument\.|\bwindow\./);
	});
});
