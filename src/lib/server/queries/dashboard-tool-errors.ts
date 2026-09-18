/**
 * Tier-P read for the top-tools call detail (task #481; all-calls mode #484).
 *
 * Reads tool parts (`part.data.type = 'tool'`) joined to `session` for the
 * agent, restricted to the session ids resolved by Tier-S ({@link listSessionIds}).
 * The base predicate depends on the requested `status`: the default `errors`
 * keeps the unified failure definition `part.data.state.status IN ('error',
 * 'failed')` (the same definition the top-tools aggregate uses), while `all`
 * drops the status constraint and returns every call. The id list is queried in
 * chunks under SQLite's variable limit and the per-chunk partials are merged in
 * JS, so a `period=all` read stays bounded (the caller caps the id set; see
 * `MAX_TOOL_SESSIONS`). `event` stays untouched.
 *
 * Paging across chunks: each chunk is asked for its newest `offset + limit`
 * rows, the union is sorted newest-first and sliced globally. That is exact —
 * the global top `offset + limit` rows can only come from the per-chunk top
 * `offset + limit` — without a second full scan. Counts and the distinct-agent
 * list are separate chunked aggregates.
 *
 * Since #538 a row also reads `part.data.state.input`/`output`, the
 * `state.time.end` bound and derives the MCP/delegation flags from the tool
 * name, so a row can feed the shared `ToolCallDetail` card.
 */
import { getDb } from '../db';
import { jsonEquals, jsonExtract, jsonIn, JSON_PATH, PART_TYPE, type Row } from '../schema';
import { isMcpTool } from '../../model/tool-kind';
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
	UNKNOWN_LABEL
} from './dashboard-shared';

/** `part.data.state.status` values that mark a failed tool call. */
const ERROR_STATUSES = ['error', 'failed'] as const;

/** Agent label: `session.agent`, or `unknown` for a NULL/blank value. */
const AGENT_EXPR = `COALESCE(NULLIF(trim(session.agent), ''), '${UNKNOWN_LABEL}')`;
/** Tool label: `part.data.tool`, or `unknown` for a NULL/blank value. */
const TOOL_EXPR = `COALESCE(NULLIF(trim(${jsonExtract(
	'part.data',
	JSON_PATH.part.tool
)}), ''), '${UNKNOWN_LABEL}')`;
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
 */
function baseWhere(status: ToolCallStatus): string {
	const typePredicate = jsonEquals('part.data', JSON_PATH.part.type, PART_TYPE.tool);
	if (status === 'all') return typePredicate;
	return `${typePredicate} AND ${jsonIn('part.data', JSON_PATH.part.status, ERROR_STATUSES)}`;
}

/** Escape LIKE wildcards so a raw search term matches literally (`ESCAPE '\'`). */
function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Bound `AND` predicates for the optional filters. Tool/agent compare the
 * displayed label expression, so filtering by `unknown` matches blank/absent
 * values; the search is a case-insensitive substring over the error text with
 * caller-supplied `%`/`_`/`\` escaped first.
 */
function buildFilters(filter: ToolErrorsFilter): {
	clause: string;
	params: Record<string, string>;
} {
	const clauses: string[] = [];
	const params: Record<string, string> = {};
	const tool = filter.tool?.trim() ?? '';
	if (tool !== '') {
		clauses.push(`${TOOL_EXPR} = :tool`);
		params[':tool'] = tool;
	}
	const agent = filter.agent?.trim() ?? '';
	if (agent !== '') {
		clauses.push(`${AGENT_EXPR} = :agent`);
		params[':agent'] = agent;
	}
	const search = filter.search?.trim() ?? '';
	if (search !== '') {
		clauses.push(`${ERROR_EXPR} LIKE :q ESCAPE '\\'`);
		params[':q'] = `%${escapeLike(search)}%`;
	}
	return { clause: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '', params };
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

/** `part.data.state.input`/`output`: `null` for a NULL/blank value. */
function toNullableText(value: unknown): string | null {
	const text = toText(value);
	return text === '' ? null : text;
}

function mapRow(row: Row): ToolErrorEntry {
	const tool = toText(row.tool);
	return {
		id: toText(row.id),
		sessionId: toText(row.session_id),
		at: toCount(row.at),
		agent: toText(row.agent),
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
	// Fetch the per-chunk newest `offset + limit`; their union contains the
	// global page (a row in the global top N is in its own chunk's top N).
	const cap = offset + limit;
	const collected: ToolErrorEntry[] = [];
	for (const ids of chunk(sessionIds, IN_CHUNK_SIZE)) {
		const sql = `
			SELECT part.id AS id,
				part.session_id AS session_id,
				part.time_created AS at,
				${AGENT_EXPR} AS agent,
				${TOOL_EXPR} AS tool,
				${STATUS_EXPR} AS status,
				${ERROR_EXPR} AS error,
				${INPUT_EXPR} AS input,
				${OUTPUT_EXPR} AS output,
				${ENDED_EXPR} AS ended_at
			FROM part
			JOIN session ON session.id = part.session_id
			WHERE part.session_id IN (${idPlaceholders(ids.length)}) AND ${where}${clause}
			ORDER BY part.time_created DESC, part.id DESC
			LIMIT :cap`;
		const rows = getDb()
			.query(sql)
			.all(bindIds({ ...params, ':cap': cap }, ids)) as Row[];
		for (const row of rows) collected.push(mapRow(row));
	}
	collected.sort(
		(a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
	);
	return collected.slice(offset, offset + limit);
}

/** Total tool calls matching every filter across the id set (single aggregate per chunk). */
export function countToolErrors(
	sessionIds: readonly string[],
	filter: ToolErrorsFilter
): number {
	if (sessionIds.length === 0) return 0;
	const { clause, params } = buildFilters(filter);
	const where = baseWhere(filter.status ?? DEFAULT_TOOL_CALL_STATUS);
	let total = 0;
	for (const ids of chunk(sessionIds, IN_CHUNK_SIZE)) {
		const sql = `
			SELECT count(*) AS count
			FROM part
			JOIN session ON session.id = part.session_id
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
	for (const ids of chunk(sessionIds, IN_CHUNK_SIZE)) {
		const sql = `
			SELECT DISTINCT ${AGENT_EXPR} AS agent
			FROM part
			JOIN session ON session.id = part.session_id
			WHERE part.session_id IN (${idPlaceholders(ids.length)}) AND ${where}`;
		const rows = getDb().query(sql).all(bindIds({}, ids)) as Row[];
		for (const row of rows) {
			const agent = toText(row.agent);
			if (agent !== '') agents.add(agent);
		}
	}
	return [...agents].sort();
}
