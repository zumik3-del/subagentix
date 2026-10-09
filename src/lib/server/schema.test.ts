/**
 * Unit tests for the nested Code Mode tool-call parsing in `schema.ts`
 * (ADR D-2, task #1497).
 *
 * `parseNestedToolCalls` is the single safe parser behind
 * `ContentRecord.toolCalls`; `mapContentRow` feeds it the raw
 * `item_metadata_tool_calls` column. The AC pins the degenerate inputs:
 * absent, malformed JSON and a non-array value must all yield `[]`, never a
 * throw. Pure and server-free: no DB, no `$lib/server` imports beyond the
 * module itself, so it runs in the plain `bun test` process.
 */
import { describe, expect, test } from 'bun:test';
import { mapContentRow, parseNestedToolCalls } from './schema';

describe('parseNestedToolCalls — degenerate inputs yield []', () => {
	test('null yields []', () => {
		expect(parseNestedToolCalls(null)).toEqual([]);
	});

	test('empty string yields []', () => {
		expect(parseNestedToolCalls('')).toEqual([]);
	});

	test('malformed JSON yields [] instead of throwing', () => {
		expect(parseNestedToolCalls('not json')).toEqual([]);
		expect(parseNestedToolCalls('[{"tool":')).toEqual([]);
		expect(parseNestedToolCalls('{"tool":"search"}')).toEqual([]);
	});

	test('non-array JSON yields []', () => {
		expect(parseNestedToolCalls('42')).toEqual([]);
		expect(parseNestedToolCalls('"search"')).toEqual([]);
		expect(parseNestedToolCalls('true')).toEqual([]);
		expect(parseNestedToolCalls('{}')).toEqual([]);
	});
});

describe('parseNestedToolCalls — entry mapping', () => {
	test('parses tool/status/input of every entry', () => {
		const raw = JSON.stringify([
			{ tool: 'synaptomind.memory_recall', status: 'completed', input: { query: 'x' } },
			{ tool: 'ziptask.get_task', status: 'error', input: { task_id: 1501 } }
		]);
		expect(parseNestedToolCalls(raw)).toEqual([
			{ tool: 'synaptomind.memory_recall', status: 'completed', input: JSON.stringify({ query: 'x' }) },
			{ tool: 'ziptask.get_task', status: 'error', input: JSON.stringify({ task_id: 1501 }) }
		]);
	});

	test('skips non-object entries', () => {
		const raw = JSON.stringify(['search', 42, null, { tool: 'search', status: 'completed' }]);
		expect(parseNestedToolCalls(raw)).toEqual([{ tool: 'search', status: 'completed', input: null }]);
	});

	test('missing or non-string tool/status coerce to ""', () => {
		const raw = JSON.stringify([{ input: {} }, { tool: 7, status: null }, {}]);
		expect(parseNestedToolCalls(raw)).toEqual([
			{ tool: '', status: '', input: '{}' },
			{ tool: '', status: '', input: null },
			{ tool: '', status: '', input: null }
		]);
	});

	test('missing input becomes null; a string input is kept verbatim', () => {
		const raw = JSON.stringify([
			{ tool: 'search', status: 'completed' },
			{ tool: 'fetch', status: 'completed', input: 'raw-text' }
		]);
		expect(parseNestedToolCalls(raw)).toEqual([
			{ tool: 'search', status: 'completed', input: null },
			{ tool: 'fetch', status: 'completed', input: 'raw-text' }
		]);
	});
});

describe('mapContentRow — nested toolCalls column', () => {
	/** The row shape `mapContentRow` expects (only the nested fields matter). */
	function nestedRow(itemMetadataToolCalls: unknown): Record<string, unknown> {
		return {
			message_id: 'm1',
			item_index: '3',
			item_type: 'tool',
			item_name: 'execute',
			item_metadata_tool_calls: itemMetadataToolCalls
		};
	}

	test('parses a well-formed toolCalls array', () => {
		const row = mapContentRow(nestedRow(JSON.stringify([{ tool: 'search', status: 'completed' }])));
		expect(row.toolCalls).toEqual([{ tool: 'search', status: 'completed', input: null }]);
		// The synthesised id is unaffected by the nested column.
		expect(row.id).toBe('m1#3');
	});

	test('an absent column yields []', () => {
		const row = mapContentRow({ message_id: 'm1', item_index: '0' });
		expect(row.toolCalls).toEqual([]);
	});

	test('a NULL column yields []', () => {
		expect(mapContentRow(nestedRow(null)).toolCalls).toEqual([]);
	});

	test('a malformed JSON column yields [] instead of throwing', () => {
		expect(mapContentRow(nestedRow('[{"tool":')).toolCalls).toEqual([]);
	});

	test('a non-array column yields []', () => {
		expect(mapContentRow(nestedRow('{"tool":"search"}')).toolCalls).toEqual([]);
		expect(mapContentRow(nestedRow('42')).toolCalls).toEqual([]);
	});
});
