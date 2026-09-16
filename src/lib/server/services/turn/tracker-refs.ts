/**
 * Tracker-reference inference for tool calls and delegation edges (spec §6
 * "ziptask link"). Pure and server-free, so the client can reuse it.
 */

/** The `part` text fields a tracker reference can be inferred from. */
export interface TrackerTexts {
	/** `state.input` JSON text. */
	input: string | null;
	/** `state.output` JSON text. */
	output: string | null;
	/** `state.input.prompt`. */
	prompt: string | null;
	/** `state.input.description`. */
	description: string | null;
}

/** Read the first present, non-empty JSON key from a `state.*` text blob. */
function jsonTrackerId(text: string | null, keys: readonly string[]): string | null {
	if (!text) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== 'object') return null;
		const record = parsed as Record<string, unknown>;
		for (const key of keys) {
			const value = record[key];
			if (value === undefined || value === null) continue;
			const id = String(value).trim();
			if (id !== '') return id;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Infer tracker references for one tool call (spec §6 "ziptask link"), in a
 * fixed order:
 * 1. `ziptask_*` calls read `state.input.task_id` / `state.input.id`, else parse
 *    `state.output.id`.
 * 2. `task` calls match `Task #(\d+)` in `state.input.prompt` / `description`.
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
	if (name === 'task') {
		const refs = new Set<string>();
		for (const text of [texts.prompt, texts.description]) {
			if (!text) continue;
			for (const match of text.matchAll(/Task #(\d+)/g)) refs.add(match[1]);
		}
		return [...refs];
	}
	return [];
}
