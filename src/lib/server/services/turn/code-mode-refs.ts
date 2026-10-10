/**
 * Tracker-reference inference for the Code Mode `execute` tool call.
 *
 * In the Code Mode harness every tracker call runs inside the built-in
 * `execute` tool, so a developer/tester node's own task ids exist only as
 * `tools.ziptask.*` source text in `state.input.code`. The body is never
 * evaluated: literal numbers in the call arguments are read out of the text.
 *
 * Pure and server-free — no `$lib/server`, DB, DOM or Node — like its sibling
 * `tracker-refs.ts`, which dispatches to {@link extractExecuteTrackerRefs}.
 */
import { jsonRecord } from './json-utils';

/**
 * The head of one `tools.ziptask.*` call, in every access form the harness
 * emits: `tools.ziptask.get_task(`, `tools["ziptask"]["update_status"](`,
 * `tools?.ziptask?.get_task?.(`, `tools["ziptask"]?.["get_task"]?.(`, with
 * arbitrary whitespace. Namespace key and method key are dotted or bracketed
 * independently, and either may carry the optional-chaining `?.`. The method
 * name is unrestricted, so a tracker tool added later is picked up for free.
 */
const ZIPTASK_CALL = new RegExp(
	String.raw`\btools\s*(?:\??\.\s*)?(?:ziptask\b|\[\s*(['"])ziptask\1\s*\])\s*` +
		String.raw`(?:\??\.)?\s*(?:[\w$]+|\[\s*(['"])[\w$]+\2\s*\])\s*(?:\?\.\s*)?\(`,
	'g'
);

/**
 * One literal task id: the `id` / `task_id` argument key followed by a number.
 * Only those exact keys qualify (`epic_id` and `depends_on` do not), and the
 * lookarounds refuse the tail of a longer identifier as well as a fractional or
 * separator-formatted literal.
 */
const LITERAL_ID = /(?<![A-Za-z0-9_$])(?:id|task_id)\s*:\s*(\d+)(?![A-Za-z0-9_$.])/g;

/** A body with its string and comment spans blanked out. */
interface MaskedSource {
	/** The masked body; offsets still line up with the source it came from. */
	text: string;
	/** `[from, to)` of each blanked span, its opening quote included. */
	spans: [number, number][];
}

/**
 * Blank every string, template-literal and comment body, keeping length and
 * offsets intact, so a task id can only be read from code: `fields: ["id"]` or
 * `comment: "fix id: 7"` contribute nothing. The spans come with it, because a
 * bracketed key is itself a string literal: the call head is matched on the raw
 * body and checked against them. Regex literals are not lexed: one containing a
 * quote or an unbalanced delimiter can blank or corrupt the code after it, and
 * one spelling a ziptask call is read as if it had run. Either way a ref can be
 * lost or invented; both are accepted, since refs stay inferred and never
 * authoritative.
 */
function maskLiterals(source: string): MaskedSource {
	const out = source.split('');
	const spans: [number, number][] = [];
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		let stop = -1;
		if (ch === '"' || ch === "'" || ch === '`') {
			let j = i + 1;
			while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
			stop = j + 1;
		} else if (ch === '/' && source[i + 1] === '/') {
			const newline = source.indexOf('\n', i);
			stop = newline === -1 ? source.length : newline;
		} else if (ch === '/' && source[i + 1] === '*') {
			const close = source.indexOf('*/', i + 2);
			stop = close === -1 ? source.length : close + 2;
		}
		if (stop === -1) {
			i++;
			continue;
		}
		for (let k = i; k < Math.min(stop, source.length); k++) out[k] = ' ';
		spans.push([i, stop]);
		i = stop;
	}
	return { text: out.join(''), spans };
}

/** The balanced `(...)` argument text that starts right after an opening `(`. */
function argumentsFrom(masked: string, from: number): string {
	let depth = 1;
	for (let i = from; i < masked.length; i++) {
		const ch = masked[i];
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') {
			depth--;
			if (depth === 0) return masked.slice(from, i);
		}
	}
	return masked.slice(from);
}

/**
 * The task ids of the `tools.ziptask.*` calls in one Code Mode body, in source
 * order and deduplicated first-seen.
 */
function executeCodeRefs(code: string): string[] {
	const mask = maskLiterals(code);
	const refs: string[] = [];
	for (const call of code.matchAll(ZIPTASK_CALL)) {
		// A head inside a string or comment is a snippet, not a call that ran.
		const blanked = mask.spans.some(([from, to]) => call.index >= from && call.index < to);
		if (blanked) continue;
		const args = argumentsFrom(mask.text, call.index + call[0].length);
		for (const literal of args.matchAll(LITERAL_ID)) refs.push(literal[1]);
	}
	return [...new Set(refs)];
}

/**
 * Tracker ids inferred from one `execute` tool call's `state.input` JSON text:
 * decode it, read `code`, and collect the literal ids of the tracker calls in
 * that body. A null, malformed or non-string `code` yields `[]` rather than
 * throwing.
 *
 * The input decode repeats `jsonRecord` from the sibling `tracker-refs.ts` so
 * that the two modules keep a one-way import instead of a cycle.
 */
export function extractExecuteTrackerRefs(input: string | null): string[] {
	const record = jsonRecord(input);
	if (record === null) return [];
	const code = record.code;
	if (typeof code !== 'string' || code === '') return [];
	return executeCodeRefs(code);
}
