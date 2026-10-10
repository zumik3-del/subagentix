/**
 * Tracker-reference inference for tool calls and delegation edges (spec §6
 * "ziptask link"). Pure and server-free, so the client can reuse it.
 *
 * The Code Mode `execute` branch lives in its sibling `code-mode-refs.ts`.
 */
import { CODE_MODE_TOOL, DELEGATION_TOOL } from '$lib/model/tool-kind';
import { extractExecuteTrackerRefs } from './code-mode-refs';
import { jsonRecord } from './json-utils';

/** The tool text fields a tracker reference can be inferred from. */
export interface TrackerTexts {
	/** `state.input` JSON text. */
	input: string | null;
	/** Joined `state.content[]` text output. */
	output: string | null;
	/** `state.input.prompt`. */
	prompt: string | null;
	/** `state.input.description`. */
	description: string | null;
}

/** Read the first present, non-empty JSON key from a `state.*` text blob. */
function jsonTrackerId(text: string | null, keys: readonly string[]): string | null {
	const record = jsonRecord(text);
	if (record === null) return null;
	for (const key of keys) {
		const value = record[key];
		if (value === undefined || value === null) continue;
		const id = String(value).trim();
		if (id !== '') return id;
	}
	return null;
}

/**
 * Infer tracker references for one tool call (spec §6 "ziptask link"), in a
 * fixed order:
 * 1. `ziptask_*` calls read `state.input.task_id` / `state.input.id`, else
 *    JSON-decode the joined output text and read its `id`.
 * 2. `execute` calls (V2's Code Mode tool, where every tracker call is
 *    `tools.ziptask.*` inside the submitted `state.input.code`) read the literal
 *    task ids out of those invocations — only this call's own body, so nothing
 *    is inherited from a delegation edge (decision D-1).
 * 3. `subagent` calls (V2's delegation tool, formerly `task`) match
 *    `Task #(\d+)` in `state.input.prompt` / `description`.
 *
 * Deduplicated in first-seen order and always inferred — never authoritative.
 */
export function extractTrackerRefs(name: string, texts: TrackerTexts): string[] {
	if (name.startsWith('ziptask_')) {
		const inputId = jsonTrackerId(texts.input, ['task_id', 'id']);
		if (inputId !== null) return [inputId];
		const outputId = jsonTrackerId(texts.output, ['id']);
		return outputId === null ? [] : [outputId];
	}
	if (name === CODE_MODE_TOOL) return extractExecuteTrackerRefs(texts.input);
	if (name === DELEGATION_TOOL) {
		const refs = new Set<string>();
		for (const text of [texts.prompt, texts.description]) {
			if (!text) continue;
			for (const match of text.matchAll(/Task #(\d+)/g)) refs.add(match[1]);
		}
		return [...refs];
	}
	return [];
}
