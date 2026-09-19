/**
 * Tier-P read for the top-tools call detail (task #481; all-calls mode #484).
 *
 * Reads tool parts (`part.data.type = 'tool'`) restricted to the session ids
 * resolved by Tier-S ({@link listSessionIds}). The base predicate depends on the
 * requested `status`: the default `errors` keeps the unified failure definition
 * `part.data.state.status IN ('error', 'failed')` (the same definition the
 * top-tools aggregate uses), while `all` drops the status constraint and returns
 * every call. The id list is queried in chunks under SQLite's variable limit and
 * the per-chunk partials are merged in JS, so a `period=all` read stays bounded
 * (the caller caps the id set; see `MAX_TOOL_SESSIONS`). `event` stays untouched.
 *
 * The `session` join is deliberately absent: `agent` is a per-session value, so
 * it is read once into a `session.id -> label` map ({@link agentBySession})
 * instead of joining it into every `part` scan. That keeps the query shape
 * simple and the session filter the driving predicate.
 *
 * Paging across chunks: each chunk is asked for its newest `offset + limit`
 * rows, the union is sorted newest-first and sliced globally. That is exact —
 * the global top `offset + limit` rows can only come from the per-chunk top
 * `offset + limit` — without a second full scan.
 *
 * Since #538 a row also reads `part.data.state.input`/`output`, the
 * `state.time.end` bound and derives the MCP/delegation flags from the tool
 * name, so a row can feed the shared `ToolCallDetail` card.
 */
import { getDb } from '../db';
import { jsonExtract, jsonIn, JSON_PATH, PART_TYPE, type Row } from '../schema';
import { isMcpTool, FAILED_TOOL_STATUSES } from '../../model/tool-kind';
import {
	DEFAULT_TOOL_CALL_STATUS,
	type ToolCallStatus,
	type ToolErrorEntry,
	type ToolErrorsFilter
} from '../../model/tool-errors';
import {
	chunk,
	IN_CHUNK_SIZE,
	isBound,
	toCount,
	toText,
	TOOL_LABEL_EXPR,
	UNKNOWN_LABEL
} from './dashboard-shared';

/** Error text: `part.data.state.error`, or an empty string when absent. */
const ERROR_EXPR = `COALESCE(${jsonExtract('part.data', JSON_PATH.part.error)}, '')`;
/** Raw status: `part.data.state.status`, or an empty string when absent. */
const STATUS_EXPR = `COALESCE(${jsonExtract('part.data', JSON_PATH.part.status)}, '')`;
/** Raw tool input (`part.data.state.input`); `null` when absent. */
const INPUT_EXPR = jsonExtract('part.data', JSON_PATH.part.stateInput);
/** Raw tool output (`part.data.state.output`); `null` when absent. */
const OUTPUT_EXPR = jsonExtract('part.data', JSON_PATH.part.stateOutput);
/** Tool end time (`part.data.state.time.end`); `null` when absent. */
const ENDED_EXPR = jsonExtract('part.data', JSON_PATH.part.stateEnd);

/**
 * The constant `part` predicate every read in this module shares, for the
 * requested mode: tool parts only, plus the failed pair unless `all` was asked.
 * The failed pair comes from {@link FAILED_TOOL_STATUSES}, the single shared
 * definition of a failed tool call.
 */
function baseWhere(status: ToolCallStatus): string {
	const typePredicate = `${jsonExtract('part.data', JSON_PATH.part.type)} = '${PART_TYPE.tool}'`;
	if (status === 'all') return typePredicate;
	return `${typePredicate} AND ${jsonIn('part.data', JSON_PATH.part.status, FAILED_TOOL_STATUSES)}`;
}

/** Escape LIKE wildcards so a raw search term matches literally (`ESCAPE '\'`). */
function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Bound `AND` predicates for the SQL-resolvable filters. The tool filter
 * compares the displayed label expression, so `unknown` matches blank/absent
 * values; the search is a case-insensitive substring over the error text with
 * caller-supplied `%`/`_`/`\` escaped first. The agent filter is deliberately
 * NOT here: `agent` is a per-session value resolved from the session map, so it
 * is applied in JS by the caller.
 */
function buildFilters(filter: ToolErrorsFilter): {
	clause: string;
	params: Record<string, string>;
} {
	const clauses: string[] = [];
	const params: Record<string, string> = {};
	const tool = filter.tool?.trim() ?? '';
	if (tool !== '') {
		clauses.push(`${TOOL_LABEL_EXPR} = :tool`);
		params[':tool'] = tool;
	}
	const search = filter.search?.trim() ?? '';
	if (search !== '') {
		clauses.push(`${ERROR_EXPR} LIKE :q ESCAPE '\\'`);
		params[':q'] = `%${escapeLike(search)}%`;
	}
	return { clause: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '', params };
}

/** The requested agent label, or `null` when no agent filter is active. */
function agentFilter(filter: ToolErrorsFilter): string | null {
	const agent = filter.agent?.trim() ?? '';
	return agent === '' ? null : agent;
}

/** Named placeholders for one chunk's session ids (`:sid_0, :sid_1, …`). */
function idPlaceholders(count: number): string {
	return Array.from({ length: count }, (_, index) => `:sid_${index}`).join(', ');
}

/** Bind `ids` onto the `:sid_N` placeholders of one chunk query. */
function bindIds(
	params: Record<string, string | number>,
	ids: readonly string[]
): Record<string, string | number> {
	const bound: Record<string, string | number> = { ...params };
	ids.forEach((id, index) => {
		bound[`:sid_${index}`] = id;
	});
	return bound;
}

/**
 * `session.id -> agent label` for the requested id set, one query per chunk.
 * A session with no row maps to `unknown`, matching the removed join's
 * `COALESCE(NULLIF(trim(session.agent), ''), 'unknown')`.
 */
function agentBySession(sessionIds: readonly string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const id of sessionIds) map.set(id, UNKNOWN_LABEL);
	const db = getDb();
	for (const ids of chunk(sessionIds, IN_CHUNK_SIZE)) {
		const sql = `SELECT session.id AS id, session.agent AS agent
			FROM session WHERE session.id IN (${idPlaceholders(ids.length)})`;
		const rows = db.query(sql).all(bindIds({}, ids)) as Row[];
		for (const row of rows) {
			const agent = toText(row.agent).trim();
			map.set(toText(row.id), agent === '' ? UNKNOWN_LABEL : agent);
		}
	}
	return map;
}

/** `part.data.state.input`/`output`: `null` for a NULL/blank value. */
function toNullableText(value: unknown): string | null {
	const text = toText(value);
	return text === '' ? null : text;
}

function mapRow(row: Row, agents: ReadonlyMap<string, string>): ToolErrorEntry {
	const tool = toText(row.tool);
	const sessionId = toText(row.session_id);
	return {
		id: toText(row.id),
		sessionId,
		at: toCount(row.at),
		agent: agents.get(sessionId) ?? UNKNOWN_LABEL,
		tool,
		status: toText(row.status),
		error: toText(row.error),
		input: toNullableText(row.input),
		output: toNullableText(row.output),
		endedAt: isBound(row.ended_at) ? row.ended_at : null,
		isMcp: isMcpTool(tool),
		isDelegation: tool === 'task'
	};
}

/** Apply the session-membership and agent filters, newest-first. */
function finalizeRows(
	rows: readonly Row[],
	allowed: ReadonlySet<string>,
	agents: ReadonlyMap<string, string>,
	filter: ToolErrorsFilter
): ToolErrorEntry[] {
	const wantedAgent = agentFilter(filter);
	const entries: ToolErrorEntry[] = [];
	for (const row of rows) {
		const sessionId = toText(row.session_id);
		if (!allowed.has(sessionId)) continue;
		const entry = mapRow(row, agents);
		if (wantedAgent !== null && entry.agent !== wantedAgent) continue;
		entries.push(entry);
	}
	entries.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
	return entries;
}

/**
 * One global page of tool calls, newest first (`part.time_created` desc, then
 * `part.id` desc). Returns `[]` for an empty id set; `offset`/`limit` are
 * assumed already clamped by the caller.
 */
export function listToolErrors(
	sessionIds: readonly string[],
	filter: ToolErrorsFilter,
	offset: number,
	limit: number
): ToolErrorEntry[] {
	if (sessionIds.length === 0 || limit <= 0) return [];
	const { clause, params } = buildFilters(filter);
	const where = baseWhere(filter.status ?? DEFAULT_TOOL_CALL_STATUS);
	const allowed = new Set(sessionIds);
	// The agent map is built once for the whole id set, not per chunk.
	const agents = agentBySession(sessionIds);
	// Fetch the per-chunk newest `offset + limit`; their union contains the
	// global page (a row in the global top N is in its own chunk's top N).
	const cap = offset + limit;
	const collected: ToolErrorEntry[] = [];
	for (const ids of chunk(sessionIds, IN_CHUNK_SIZE)) {
		const sql = `
			SELECT part.id AS id,
				part.session_id AS session_id,
				part.time_created AS at,
				${TOOL_LABEL_EXPR} AS tool,
				${STATUS_EXPR} AS status,
				${ERROR_EXPR} AS error,
				${INPUT_EXPR} AS input,
				${OUTPUT_EXPR} AS output,
				${ENDED_EXPR} AS ended_at
			FROM part
			WHERE part.session_id IN (${idPlaceholders(ids.length)}) AND ${where}${clause}
			ORDER BY part.time_created DESC, part.id DESC
			LIMIT :cap`;
		const rows = getDb()
			.query(sql)
			.all(bindIds({ ...params, ':cap': cap }, ids)) as Row[];
		collected.push(...finalizeRows(rows, allowed, agents, filter));
	}
	collected.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
	return collected.slice(offset, offset + limit);
}

/**
 * Total tool calls matching every filter across the id set (single aggregate
 * per chunk). The agent filter, being a per-session label, is applied by
 * narrowing the session set first and then counting the SQL filters only —
 * no row materialization.
 */
export function countToolErrors(
	sessionIds: readonly string[],
	filter: ToolErrorsFilter
): number {
	if (sessionIds.length === 0) return 0;
	const wantedAgent = agentFilter(filter);
	if (wantedAgent !== null) {
		const agents = agentBySession(sessionIds);
		sessionIds = sessionIds.filter((id) => agents.get(id) === wantedAgent);
		if (sessionIds.length === 0) return 0;
	}
	const { clause, params } = buildFilters(filter);
	const where = baseWhere(filter.status ?? DEFAULT_TOOL_CALL_STATUS);
	let total = 0;
	for (const ids of chunk(sessionIds, IN_CHUNK_SIZE)) {
		const sql = `
			SELECT count(*) AS count
			FROM part
			WHERE part.session_id IN (${idPlaceholders(ids.length)}) AND ${where}${clause}`;
		const row = getDb().query(sql).get(bindIds(params, ids)) as Row | null;
		total += toCount(row?.count);
	}
	return total;
}

/**
 * Distinct agent labels in the base set (period/scope + `status` only — tool,
 * agent and search are deliberately ignored so the option list stays stable
 * while the user filters). Ascending; `unknown` is included so blank agents can
 * be selected back.
 */
export function listToolErrorAgents(
	sessionIds: readonly string[],
	status: ToolCallStatus = DEFAULT_TOOL_CALL_STATUS
): string[] {
	if (sessionIds.length === 0) return [];
	const where = baseWhere(status);
	const agents = new Set<string>();
	const allowed = new Set(sessionIds);
	const matched = new Set<string>();
	for (const ids of chunk(sessionIds, IN_CHUNK_SIZE)) {
		const sql = `
			SELECT part.session_id AS session_id
			FROM part
			WHERE part.session_id IN (${idPlaceholders(ids.length)}) AND ${where}`;
		const rows = getDb().query(sql).all(bindIds({}, ids)) as Row[];
		for (const row of rows) {
			const id = toText(row.session_id);
			if (allowed.has(id)) matched.add(id);
		}
	}
	for (const [, agent] of agentBySession([...matched])) agents.add(agent);
	return [...agents].sort();
}
