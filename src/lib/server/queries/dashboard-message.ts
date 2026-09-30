/**
 * Tier-M dashboard aggregates: `session_message` usage by UTC day (V2).
 *
 * Reads `session_message` only for the session ids resolved by Tier-S
 * ({@link listSessionIds} in `dashboard-sessions.ts`), in chunks under SQLite's
 * variable limit, merging the per-chunk partial sums in JS. Only
 * `type='assistant'` rows carry cost/tokens (V2 put the former `message.data`
 * payload on `session_message.data`); `event` stays untouched.
 */
import { getDb } from '../db';
import { jsonExtract, JSON_PATH, MESSAGE_TYPE, tokenCounts, type Row } from '../schema';
import type { TokenCounts } from '../../model/token';
import {
	chunk,
	IN_CHUNK_SIZE,
	isBound,
	toCount,
	toText,
	type DashboardWindow
} from './dashboard-shared';

/** One UTC-day bucket of `session_message` usage (`data.cost` + `data.tokens.*`). */
export interface MessageDayRecord {
	/** UTC calendar day, `YYYY-MM-DD`. */
	day: string;
	/** Summed `session_message.data.cost`. */
	cost: number;
	/** Summed `session_message.data.tokens.*` categories. */
	tokens: TokenCounts;
}

/** Zeroed {@link TokenCounts} accumulator for the day merge. */
function zeroTokens(): TokenCounts {
	return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * `session_message` usage grouped by UTC calendar day, ascending: gross cost
 * plus the five token categories, over `type='assistant'` rows only. The id list
 * is queried in chunks of {@link IN_CHUNK_SIZE} and the per-day partial sums are
 * merged in JS, so a `period=all` call over thousands of sessions stays under
 * SQLite's bound-parameter limit. A `null` `from`/`to` is unbounded; when bound,
 * the message timestamp is filtered too, restricted to the same half-open window
 * as the session set.
 *
 * The day key and window filter use the `session_message.time_created` column —
 * the NOT NULL mirror of `data.time.created` (they are equal on every live row),
 * unlike a `json_extract` per scanned row. The JSON path stays the single source
 * for the cost/token payload via `schema.ts`.
 *
 * Index note (spec §5) — V2 has standalone `session_message_time_created_idx` as
 * well as `session_message_session_type_seq_idx(session_id, type, seq)`, so the
 * chunked `session_id IN (…) AND type='assistant'` reads are index-driven; the
 * V1 "full `message` scan" note no longer applies. A future change could drop
 * the id chunks and filter on time alone (the standalone index covers it).
 */
export function aggregateMessageUsageByUtcDay(
	sessionIds: readonly string[],
	window: DashboardWindow = {}
): MessageDayRecord[] {
	if (sessionIds.length === 0) return [];
	const costExpr = jsonExtract('m.data', JSON_PATH.message.cost);
	const inputExpr = jsonExtract('m.data', JSON_PATH.message.input);
	const outputExpr = jsonExtract('m.data', JSON_PATH.message.output);
	const reasoningExpr = jsonExtract('m.data', JSON_PATH.message.reasoning);
	const cacheReadExpr = jsonExtract('m.data', JSON_PATH.message.cacheRead);
	const cacheWriteExpr = jsonExtract('m.data', JSON_PATH.message.cacheWrite);

	const totals = new Map<string, MessageDayRecord>();
	for (const ids of chunk(sessionIds, IN_CHUNK_SIZE)) {
		const clauses = [
			`m.session_id IN (${ids.map(() => '?').join(', ')})`,
			`m.type = '${MESSAGE_TYPE.assistant}'`
		];
		const params: Array<string | number> = [...ids];
		if (isBound(window.from)) {
			clauses.push('m.time_created >= ?');
			params.push(window.from);
		}
		if (isBound(window.to)) {
			clauses.push('m.time_created < ?');
			params.push(window.to);
		}
		const sql = `
			SELECT date(m.time_created / 1000, 'unixepoch') AS day,
				COALESCE(sum(${costExpr}), 0) AS cost,
				COALESCE(sum(${inputExpr}), 0) AS tok_input,
				COALESCE(sum(${outputExpr}), 0) AS tok_output,
				COALESCE(sum(${reasoningExpr}), 0) AS tok_reasoning,
				COALESCE(sum(${cacheReadExpr}), 0) AS cache_read,
				COALESCE(sum(${cacheWriteExpr}), 0) AS cache_write
			FROM session_message m
			WHERE ${clauses.join(' AND ')}
			GROUP BY day`;
		const rows = getDb().query(sql).all(...params) as Row[];
		for (const row of rows) {
			const day = toText(row.day);
			if (day === '') continue;
			const usage = tokenCounts(row);
			const entry = totals.get(day) ?? { day, cost: 0, tokens: zeroTokens() };
			entry.cost += toCount(row.cost);
			entry.tokens.input += usage.input;
			entry.tokens.output += usage.output;
			entry.tokens.reasoning += usage.reasoning;
			entry.tokens.cacheRead += usage.cacheRead;
			entry.tokens.cacheWrite += usage.cacheWrite;
			totals.set(day, entry);
		}
	}
	return [...totals.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
