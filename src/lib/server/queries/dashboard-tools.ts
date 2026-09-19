/**
 * Tier-P dashboard aggregate: tool frequency.
 *
 * Reads `part` only for the session ids resolved by Tier-S ({@link listSessionIds}
 * in `dashboard-sessions.ts`), in chunks under SQLite's variable limit, merging
 * the per-chunk partials in JS. `event` stays untouched.
 */
import { BASIC_TOOL_NAMES, FAILED_TOOL_STATUSES } from '../../model/tool-kind';
import { getDb } from '../db';
import { jsonEquals, jsonIn, JSON_PATH, PART_TYPE, type Row } from '../schema';
import {
	chunk,
	DEFAULT_TOP_N,
	IN_CHUNK_SIZE,
	sanitizeLimit,
	toCount,
	toText,
	TOOL_LABEL_EXPR
} from './dashboard-shared';

/** One grouped tool-count record from the `part` read. */
export interface ToolUsageRecord {
	/** Tool name; `unknown` for a NULL/blank `part.data.tool`. */
	name: string;
	/** Matching tool parts in the chunked session set. */
	count: number;
	/** Of `count`, parts whose `state.status` is `error` or `failed`. */
	errors: number;
}

/**
 * Which tool kinds a Tier-P aggregate includes: `basic` = the built-in
 * allowlist, `mcp` = every other name. Both `true` (or the whole argument
 * omitted) means no kind clause; both `false` means no matching tool at all
 * (the service short-circuits before ever reaching this module).
 */
export interface ToolKindSelection {
	/** Include the built-in allowlist names. */
	basic: boolean;
	/** Include every name outside the allowlist (MCP). */
	mcp: boolean;
}

/**
 * The built-in allowlist as SQL literals. {@link BASIC_TOOL_NAMES} is a
 * compile-time constant, never user input, so inlining the values is safe and
 * keeps the session-id bindings positional and unchanged.
 */
const BASIC_TOOL_SQL = BASIC_TOOL_NAMES.map((name) => `'${name}'`).join(', ');

/**
 * The `AND <toolExpr> …` predicate restricting a scan to the selected kinds
 * (`''` when both are on, so the unfiltered query is byte-identical to before).
 * `basic`-only selects the allowlist, `mcp`-only excludes it; everything not
 * allowlisted is MCP. Applied before `GROUP BY`, so the top-N counts only the
 * selected kinds.
 */
function toolKindClause(kinds: ToolKindSelection | undefined, toolExpr: string): string {
	const basic = kinds?.basic ?? true;
	const mcp = kinds?.mcp ?? true;
	if (basic && mcp) return '';
	if (basic) return ` AND ${toolExpr} IN (${BASIC_TOOL_SQL})`;
	if (mcp) return ` AND ${toolExpr} NOT IN (${BASIC_TOOL_SQL})`;
	// Both off: no row matches. Defensive only — callers short-circuit first.
	return ' AND 0';
}

/**
 * Tool parts grouped by `part.data.tool`, restricted to the given session ids
 * (`part_session_idx`), each group carrying its total `count` and its `errors`
 * (`state.status IN ('error', 'failed')`). The id list is queried in chunks of
 * {@link IN_CHUNK_SIZE} and the per-tool partials are merged in JS, so a
 * `period=all` call stays under SQLite's bound-parameter limit; the caller caps
 * the id set itself (see `MAX_TOOL_SESSIONS`), which is what keeps the `part`
 * scan bounded. `kinds` restricts the group key to the selected tool kinds
 * (applied in SQL before `GROUP BY`, never post-filtered), so an excluded
 * high-count tool cannot consume a top-N slot. There is no `part.time_created`
 * filter: `part` has no time index, and the spec design windows Tier P by
 * session id only. Sorted count desc then name asc and cut to the top-N.
 */
export function aggregateToolUsage(
	sessionIds: readonly string[],
	limit = DEFAULT_TOP_N,
	kinds?: ToolKindSelection
): ToolUsageRecord[] {
	if (sessionIds.length === 0) return [];
	if (kinds?.basic === false && kinds.mcp === false) return [];
	const typeFilter = jsonEquals('part.data', JSON_PATH.part.type, PART_TYPE.tool);
	const errorFilter = jsonIn('part.data', JSON_PATH.part.status, FAILED_TOOL_STATUSES);
	const kindFilter = toolKindClause(kinds, TOOL_LABEL_EXPR);

	const totals = new Map<string, ToolUsageRecord>();
	for (const ids of chunk(sessionIds, IN_CHUNK_SIZE)) {
		const sql = `
			SELECT ${TOOL_LABEL_EXPR} AS name,
				count(*) AS count,
				COALESCE(sum(CASE WHEN ${errorFilter} THEN 1 ELSE 0 END), 0) AS errors
			FROM part
			WHERE part.session_id IN (${ids.map(() => '?').join(', ')}) AND ${typeFilter}${kindFilter}
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
