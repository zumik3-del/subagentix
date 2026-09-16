/**
 * Tier-P dashboard aggregate: tool frequency.
 *
 * Reads `part` only for the session ids resolved by Tier-S ({@link listSessionIds}
 * in `dashboard-sessions.ts`), in chunks under SQLite's variable limit, merging
 * the per-chunk partials in JS. `event` stays untouched.
 */
import { getDb } from '../db';
import { jsonEquals, jsonExtract, JSON_PATH, PART_TYPE, type Row } from '../schema';
import {
	chunk,
	DEFAULT_TOP_N,
	IN_CHUNK_SIZE,
	sanitizeLimit,
	toCount,
	toText,
	UNKNOWN_LABEL
} from './dashboard-shared';

/** One grouped tool-count record from the `part` read. */
export interface ToolUsageRecord {
	/** Tool name; `unknown` for a NULL/blank `part.data.tool`. */
	name: string;
	/** Matching tool parts in the chunked session set. */
	count: number;
	/** Of `count`, parts whose `state.status` is `error`. */
	errors: number;
}

/** `part.data.state.status` value marking a failed tool call. */
const ERROR_STATUS = 'error';

/**
 * Tool parts grouped by `part.data.tool`, restricted to the given session ids
 * (`part_session_idx`), each group carrying its total `count` and its `errors`
 * (`state.status = 'error'`). The id list is queried in chunks of
 * {@link IN_CHUNK_SIZE} and the per-tool partials are merged in JS, so a
 * `period=all` call stays under SQLite's bound-parameter limit; the caller caps
 * the id set itself (see `MAX_TOOL_SESSIONS`), which is what keeps the `part`
 * scan bounded. There is no `part.time_created` filter: `part` has no time
 * index, and the spec design windows Tier P by session id only. Sorted count
 * desc then name asc and cut to the top-N.
 */
export function aggregateToolUsage(
	sessionIds: readonly string[],
	limit = DEFAULT_TOP_N
): ToolUsageRecord[] {
	if (sessionIds.length === 0) return [];
	const typeFilter = jsonEquals('part.data', JSON_PATH.part.type, PART_TYPE.tool);
	const errorFilter = jsonEquals('part.data', JSON_PATH.part.status, ERROR_STATUS);
	const toolExpr = `COALESCE(NULLIF(trim(${jsonExtract(
		'part.data',
		JSON_PATH.part.tool
	)}), ''), '${UNKNOWN_LABEL}')`;

	const totals = new Map<string, ToolUsageRecord>();
	for (const ids of chunk(sessionIds, IN_CHUNK_SIZE)) {
		const sql = `
			SELECT ${toolExpr} AS name,
				count(*) AS count,
				COALESCE(sum(CASE WHEN ${errorFilter} THEN 1 ELSE 0 END), 0) AS errors
			FROM part
			WHERE part.session_id IN (${ids.map(() => '?').join(', ')}) AND ${typeFilter}
			GROUP BY name`;
		const rows = getDb().query(sql).all(...ids) as Row[];
		for (const row of rows) {
			const name = toText(row.name);
			const entry = totals.get(name) ?? { name, count: 0, errors: 0 };
			entry.count += toCount(row.count);
			entry.errors += toCount(row.errors);
			totals.set(name, entry);
		}
	}
	return [...totals.values()]
		.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.slice(0, sanitizeLimit(limit));
}
