/**
 * Unit tests for the Code Mode `execute` tracker-ref parser (task #1143).
 *
 * The fixture suite `src/lib/server/m4a-tracker.suite.ts` covers this branch
 * end-to-end through `buildTurnModel`, but it can only feed `state.input`
 * values the SQLite row actually stores — always valid JSON. The degenerate
 * `state.input` texts an upstream harness could still hand us (unparseable
 * text, a bare scalar, an array) are only reachable by calling the parser
 * directly, which is why this file exists. Pure and server-free: no DB, no
 * `$lib/server`, so it runs in the plain `bun test` process.
 */
import { describe, expect, test } from 'bun:test';
import { extractExecuteTrackerRefs } from './code-mode-refs';

/** `state.input` JSON text for one Code Mode body. */
const input = (code: string): string => JSON.stringify({ code });

describe('extractExecuteTrackerRefs — unusable state.input yields no ref', () => {
	test('a null input yields no ref', () => {
		expect(extractExecuteTrackerRefs(null)).toEqual([]);
	});

	test('an unparseable input text yields no ref instead of throwing', () => {
		expect(extractExecuteTrackerRefs('not json')).toEqual([]);
		expect(extractExecuteTrackerRefs('{"code":')).toEqual([]);
		expect(extractExecuteTrackerRefs('')).toEqual([]);
	});

	test('a JSON scalar input yields no ref', () => {
		for (const text of ['42', 'null', 'true', '"tools.ziptask.get_task({ id: 1 })"']) {
			expect(extractExecuteTrackerRefs(text)).toEqual([]);
		}
	});

	test('an array input yields no ref', () => {
		expect(extractExecuteTrackerRefs('[{"code":"tools.ziptask.get_task({ id: 1 })"}]')).toEqual([]);
	});
});

describe('extractExecuteTrackerRefs — unusable state.input.code yields no ref', () => {
	test('an empty body yields no ref', () => {
		expect(extractExecuteTrackerRefs(input(''))).toEqual([]);
	});

	test('a missing code yields no ref', () => {
		expect(extractExecuteTrackerRefs(JSON.stringify({ text: 'tools.ziptask.get_task({ id: 1 })' }))).toEqual([]);
	});

	test('a non-string code yields no ref', () => {
		for (const code of [42, null, true, { body: 'tools.ziptask.get_task({ id: 1 })' }, ['a']]) {
			expect(extractExecuteTrackerRefs(JSON.stringify({ code }))).toEqual([]);
		}
	});
});

describe('extractExecuteTrackerRefs — call access forms', () => {
	test('reads the dot form', () => {
		expect(extractExecuteTrackerRefs(input('const t = await tools.ziptask.get_task({ id: 7 });'))).toEqual(['7']);
	});

	test('reads the bracket form, namespace and method key both bracketed', () => {
		expect(extractExecuteTrackerRefs(input('const t = await tools["ziptask"]["update_status"]({ id: 8 });'))).toEqual(['8']);
	});

	test('reads a bracket namespace with a dotted method key', () => {
		expect(extractExecuteTrackerRefs(input('const t = await tools["ziptask"].get_task({ id: 9 });'))).toEqual(['9']);
	});

	test('tolerates arbitrary whitespace', () => {
		expect(extractExecuteTrackerRefs(input('const t = await tools  .  ziptask  .  get_task  ( { id : 10 } ) ;'))).toEqual(['10']);
	});

	test('tolerates optional chaining on every step', () => {
		expect(extractExecuteTrackerRefs(input('const t = await tools?.ziptask?.get_task?.({ id: 11 });'))).toEqual(['11']);
		expect(extractExecuteTrackerRefs(input('const t = await tools["ziptask"]?.["get_task"]?.({ id: 12 });'))).toEqual(['12']);
		expect(extractExecuteTrackerRefs(input('const t = await tools ?. ziptask ?. get_task ?. ({ id: 13 });'))).toEqual(['13']);
	});

	test('an unterminated argument list still yields the ids it holds', () => {
		expect(extractExecuteTrackerRefs(input('const t = await tools.ziptask.get_task({ id: 14, fields: ['))).toEqual(['14']);
	});
});

describe('extractExecuteTrackerRefs — which arguments count as a ref', () => {
	test('collects `id` and `task_id` literals in source order across calls', () => {
		const code = [
			'const first = await tools.ziptask.get_task({ id: 20 });',
			'const second = await tools.ziptask.update_status({ task_id: 21, status: "review" });',
			'const third = await tools.ziptask.add_comment({ id: 22, comment: "done" });'
		].join('\n');
		expect(extractExecuteTrackerRefs(input(code))).toEqual(['20', '21', '22']);
	});

	test('deduplicates repeated ids first-seen', () => {
		const code = [
			'const a = await tools.ziptask.get_task({ id: 30 });',
			'const b = await tools.ziptask.add_comment({ id: 30, comment: "again" });',
			'const c = await tools.ziptask.get_task({ id: 31 });'
		].join('\n');
		expect(extractExecuteTrackerRefs(input(code))).toEqual(['30', '31']);
	});

	test('`epic_id` and other keys are not refs', () => {
		const code = 'const e = await tools.ziptask.list_tasks({ epic_id: 40, parent_id: 41, status: "queued" });';
		expect(extractExecuteTrackerRefs(input(code))).toEqual([]);
	});

	test('a quoted id is not a literal ref', () => {
		const code = [
			'const a = await tools.ziptask.get_task({ id: "50" });',
			"const b = await tools.ziptask.get_task({ task_id: '51' });",
			'const c = await tools.ziptask.get_task({ id: `52` });'
		].join('\n');
		expect(extractExecuteTrackerRefs(input(code))).toEqual([]);
	});

	test('a longer identifier or a fractional literal is not a ref', () => {
		expect(extractExecuteTrackerRefs(input('const a = await tools.ziptask.get_task({ valid_id: 61 });'))).toEqual([]);
		expect(extractExecuteTrackerRefs(input('const b = await tools.ziptask.get_task({ id: 62.5 });'))).toEqual([]);
		expect(extractExecuteTrackerRefs(input('const c = await tools.ziptask.get_task({ id: 1e3 });'))).toEqual([]);
	});

	test('`task_id` is a ref next to a rejected longer key', () => {
		const code = 'const a = await tools.ziptask.get_task({ task_id: 63, valid_id: 64 });';
		expect(extractExecuteTrackerRefs(input(code))).toEqual(['63']);
	});
});

describe('extractExecuteTrackerRefs — only code counts', () => {
	test('a call inside a comment is a snippet, not a call that ran', () => {
		const code = ['// tools.ziptask.get_task({ id: 70 })', '/* tools.ziptask.get_task({ id: 71 }) */'].join('\n');
		expect(extractExecuteTrackerRefs(input(code))).toEqual([]);
	});

	test('a call inside a string or template literal is a snippet', () => {
		expect(extractExecuteTrackerRefs(input('const s = \'tools.ziptask.get_task({ id: 72 })\';'))).toEqual([]);
		expect(extractExecuteTrackerRefs(input('const s = `tools.ziptask.get_task({ id: 73 })`;'))).toEqual([]);
	});

	test('digits inside a string argument of a call that does run are not refs', () => {
		const comment = 'const c = await tools.ziptask.add_comment({ id: 75, comment: "blocked on id: 76 and Task #77" });';
		expect(extractExecuteTrackerRefs(input(comment))).toEqual(['75']);
	});

	test('digits inside a comment inside a call are not refs', () => {
		const code = 'const c = await tools.ziptask.get_task({ id: 78 /* was 79 */ });';
		expect(extractExecuteTrackerRefs(input(code))).toEqual(['78']);
	});

	test('a call interpolated into a template literal is not read (documented blind spot)', () => {
		// The masker blanks the whole template body, so an id interpolated into
		// one is lost. It can only lose a ref, never invent one.
		const code = 'const s = `task ${tools.ziptask.get_task({ id: 74 })}`;';
		expect(extractExecuteTrackerRefs(input(code))).toEqual([]);
	});

	test('a computed method key contributes nothing and an earlier snippet cannot stand in for it', () => {
		// `tools.ziptask[method](...)` is not a head the parser can read, and the
		// snippet head inside the string must not drag the call's id in as a
		// phantom ref.
		const code = [
			'const s = \'tools.ziptask.get_task({ id: 84 })\';',
			'const t = await tools.ziptask[method]({ id: 85 });'
		].join('\n');
		expect(extractExecuteTrackerRefs(input(code))).toEqual([]);
	});

	test('real calls around a snippet still contribute', () => {
		const code = [
			'// tools.ziptask.get_task({ id: 80 })',
			'const snippet = \'tools.ziptask.get_task({ id: 81 })\';',
			'const t = await tools.ziptask.get_task({ id: 82 });'
		].join('\n');
		expect(extractExecuteTrackerRefs(input(code))).toEqual(['82']);
	});

	test('a regex literal is not lexed, so its body can read as a call (blind spot)', () => {
		// Pinned as-is: `maskLiterals` does not lex regex literals, so a regex
		// body shaped like a call contributes a ref it should not, and it leads
		// the order. `code-mode-refs.ts` documents this inventing consequence
		// (and the lossy unbalanced-delimiter one). Any fix must update this
		// expectation on purpose.
		expect(extractExecuteTrackerRefs(input('const re = /tools.ziptask.get_task({ id: 86 })/;'))).toEqual(['86']);
		const withReal = [
			'const re = /tools.ziptask.get_task({ id: 86 })/;',
			'const t = await tools.ziptask.get_task({ id: 87 });'
		].join('\n');
		expect(extractExecuteTrackerRefs(input(withReal))).toEqual(['86', '87']);
	});

	test('a quote inside a regex literal swallows the rest of the body (blind spot)', () => {
		const code = ['const re = /\'/;', 'const t = await tools.ziptask.get_task({ id: 88 });'].join('\n');
		expect(extractExecuteTrackerRefs(input(code))).toEqual([]);
	});

	test('an id outside any call arguments is not a ref', () => {
		expect(extractExecuteTrackerRefs(input('const budget = 5000; const t = await tools.ziptask.list_queue({ limit: 10 });'))).toEqual([]);
	});

	test('a non-ziptask namespace is not a call', () => {
		const code = [
			'const a = await tools.ziptaskish.get_task({ id: 90 });',
			'const b = await tools.synaptomind.memory_recall({ action: "context", id: 91 });',
			'const c = await ziptask_get_task({ id: 92 });'
		].join('\n');
		expect(extractExecuteTrackerRefs(input(code))).toEqual([]);
	});
});
