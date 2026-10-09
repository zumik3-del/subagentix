import { describe, expect, test } from 'bun:test';
import {
	BASIC_TOOL_NAMES,
	isBasicTool,
	isMcpTool,
	toolKind,
	type ToolKind
} from './tool-kind';

/**
 * Unit tests for the client-safe tool-kind classifier (epic #512, task #515).
 *
 * Pure and deterministic: no I/O, no imports beyond the module itself.
 */

describe('BASIC_TOOL_NAMES', () => {
	test('contains exactly the 18 documented names', () => {
		expect(BASIC_TOOL_NAMES).toHaveLength(18);
	});

	test('lists every expected built-in tool', () => {
		const expected = [
			'bash',
			'shell',
			'execute',
			'read',
			'edit',
			'write',
			'grep',
			'glob',
			'task',
			'subagent',
			'todowrite',
			'webfetch',
			'websearch',
			'search',
			'fetch',
			'skill',
			'question',
			'invalid'
		];
		expect(BASIC_TOOL_NAMES).toEqual(expected);
	});
});

describe('isBasicTool()', () => {
	test('true for every allowlisted name', () => {
		for (const name of BASIC_TOOL_NAMES) {
			expect(isBasicTool(name)).toBe(true);
		}
	});

	test('false for namespaced MCP tool names', () => {
		const namespaced = [
			'ziptask_update_status',
			'synaptomind_memory_recall',
			'wiki-llm_search',
			'forgejo_get_issue',
			'weather_get_weather',
			'telegram_send_message'
		];
		for (const name of namespaced) {
			expect(isBasicTool(name)).toBe(false);
		}
	});

	test('false for the synthesised unknown name', () => {
		expect(isBasicTool('unknown')).toBe(false);
	});

	test('is case-sensitive: Bash is not basic', () => {
		expect(isBasicTool('Bash')).toBe(false);
		expect(isBasicTool('Bash')).not.toBe(true);
	});

	test('false for arbitrary strings', () => {
		for (const name of ['hello', 'my-tool', 'foo_bar', '']) {
			expect(isBasicTool(name)).toBe(false);
		}
	});
});

describe('isMcpTool()', () => {
	test('false for every allowlisted name', () => {
		for (const name of BASIC_TOOL_NAMES) {
			expect(isMcpTool(name)).toBe(false);
		}
	});

	test('true for namespaced MCP tool names', () => {
		const namespaced = [
			'ziptask_update_status',
			'synaptomind_memory_recall',
			'wiki-llm_search',
			'forgejo_get_issue',
			'weather_get_weather',
			'telegram_send_message'
		];
		for (const name of namespaced) {
			expect(isMcpTool(name)).toBe(true);
		}
	});

	test('true for the synthesised unknown name', () => {
		expect(isMcpTool('unknown')).toBe(true);
	});

	test('true for invalid (invalid maps to basic via isBasicTool, so isMcpTool is false)', () => {
		// 'invalid' is explicitly in the allowlist, so it is basic, not MCP.
		expect(isMcpTool('invalid')).toBe(false);
	});

	test('true for case-variant names', () => {
		expect(isMcpTool('Bash')).toBe(true);
		expect(isMcpTool('READ')).toBe(true);
	});

	test('true for arbitrary strings', () => {
		for (const name of ['hello', 'my-tool', 'foo_bar', '']) {
			expect(isMcpTool(name)).toBe(true);
		}
	});
});

describe('dot-namespace rule (ADR D-3)', () => {
	test('isMcpTool is true for dot-namespaced <server>.<tool> names', () => {
		const dotNamespaced = [
			'synaptomind.memory_recall',
			'ziptask.get_task',
			'ziptask.update_status',
			'weather.get_weather',
			'telegram.send_message'
		];
		for (const name of dotNamespaced) {
			expect(isMcpTool(name)).toBe(true);
		}
	});

	test('isBasicTool is false for dot-namespaced names', () => {
		for (const name of ['synaptomind.memory_recall', 'ziptask.get_task']) {
			expect(isBasicTool(name)).toBe(false);
		}
	});

	test('toolKind returns mcp for dot-namespaced names', () => {
		expect(toolKind('synaptomind.memory_recall')).toBe('mcp');
		expect(toolKind('ziptask.get_task')).toBe('mcp');
	});

	test('search and fetch are Code Mode built-ins: basic, not MCP', () => {
		// ADR D-3: the only non-dotted nested names recorded inside `execute`
		// items are the Code Mode built-ins `search` and `fetch`.
		expect(isBasicTool('search')).toBe(true);
		expect(isBasicTool('fetch')).toBe(true);
		expect(isMcpTool('search')).toBe(false);
		expect(isMcpTool('fetch')).toBe(false);
		expect(toolKind('search')).toBe('basic');
		expect(toolKind('fetch')).toBe('basic');
	});
});

describe('toolKind()', () => {
	test('returns basic for every allowlisted name', () => {
		for (const name of BASIC_TOOL_NAMES) {
			expect(toolKind(name)).toBe('basic');
		}
	});

	test('returns mcp for namespaced names', () => {
		const namespaced = [
			'ziptask_update_status',
			'synaptomind_memory_recall',
			'wiki-llm_search',
			'forgejo_get_issue',
			'weather_get_weather',
			'telegram_send_message'
		];
		for (const name of namespaced) {
			expect(toolKind(name)).toBe('mcp');
		}
	});

	test('returns mcp for unknown', () => {
		expect(toolKind('unknown')).toBe('mcp');
	});

	test('returns basic for invalid', () => {
		expect(toolKind('invalid')).toBe('basic');
	});

	test('returns mcp for case variant', () => {
		expect(toolKind('Bash')).toBe('mcp');
	});

	test('return type is strictly ToolKind', () => {
		const kind: ToolKind = toolKind('bash');
		expect(kind).toBe('basic');
		const kind2: ToolKind = toolKind('weather_get_weather');
		expect(kind2).toBe('mcp');
	});
});
