/**
 * Tier-P read for the top-tools call detail (task #481; all-calls mode #484; V2).
 *
 * Walks the tool `data.content[]` items of `session_message`
 * (`json_each(m.data, '$.content')`, `$.type = 'tool'`) restricted to the session
 * ids resolved by Tier-S ({@link listSessionIds}). The base predicate depends on
 * the requested `status`: the default `errors` keeps the unified failure
 * definition `$.state.status IN ('error', 'failed')` (the same definition the
 * top-tools aggregate uses), while `all` drops the status constraint and returns
 * every call. The id list is queried in chunks under SQLite's variable limit and
 * the per-chunk partials are merged in JS, so a `period=all` read stays bounded
 * (the caller caps the id set; see `MAX_TOOL_SESSIONS`). `event` stays untouched.
 *
 * The `session_v2` join is deliberately absent: `agent` is a per-session value,
 * so it is read once into a `session.id -> label` map ({@link agentBySession})
 * instead of joining it into every content scan. That keeps the query shape
 * simple and the session filter the driving predicate (the session-id predicate
 * plus `type='assistant'` keeps the outer read on
 * `session_message_session_type_seq_idx`; decision D-3).
 *
 * Paging across chunks: each chunk is asked for its newest `offset + limit`
 * rows, the union is sorted newest-first and sliced globally. That is exact —
 * the global top `offset + limit` rows can only come from the per-chunk top
 * `offset + limit` — without a second full scan.
 *
 * A row carries the content item's `$.id` (the former `callID`), `$.state.input`
 * and the joined `$.state.content` text output, the item's `time.completed` end
 * and the MCP/delegation flags derived from the tool name, so a row can feed the
 * shared `ToolCallDetail` card.
 */
import { getDb } from '../db';
import {
	jsonEquals,
	jsonExtract,
	jsonIn,
	JSON_PATH,
	CONTENT_TYPE,
	MESSAGE_TYPE,
	toolOutputText,
	type Row
} from '../schema';
import { isMcpTool, FAILED_TOOL_STATUSES } from '../../model/tool-kind';
import {
	DEFAULT_TOOL_CALL_STATUS,
	type ToolCallStatus,
	type ToolErrorEntry,
	type ToolErrorsFilter
} from '../../model/tool-errors';
import {
	chunk,
	CONTENT_ITEM_ALIAS,
	IN_CHUNK_SIZE,
	isBound,
	nestedToolCallFrom,
	nestedToolCallsArrayGuard,
	NESTED_TOOL_CALL_ALIAS,
	NESTED_TOOL_LABEL_EXPR,
	NESTED_STATUS_EXPR,
	NESTED_INPUT_EXPR,
	toCount,
	toText,
	TOOL_LABEL_EXPR,
	UNKNOWN_LABEL
} from './dashboard-shared';

/** The `json_each` item alias (`j.value` is the content item). */
const ITEM = `${CONTENT_ITEM_ALIAS}.value`;
/** The nested `json_each` item alias (`tc.value` is the nested entry). */
const NESTED_ITEM = `${NESTED_TOOL_CALL_ALIAS}.value`;
/** Error text: `$.state.error.message`, or an empty string when absent. */
const ERROR_EXPR = `COALESCE(${jsonExtract(ITEM, JSON_PATH.content.errorMessage)}, '')`;
/** Raw status: `$.state.status`, or an empty string when absent. */
const STATUS_EXPR = `COALESCE(${jsonExtract(ITEM, JSON_PATH.content.status)}, '')`;
/** Raw tool input (`$.state.input`); `null` when absent. */
const INPUT_EXPR = jsonExtract(ITEM, JSON_PATH.content.input);
/** Raw tool output (`$.state.content` JSON array text); `null` when absent. */
const CONTENT_EXPR = jsonExtract(ITEM, JSON_PATH.content.content);
/** Tool end time (`$.time.completed`); `null` when absent. */
const ENDED_EXPR = jsonExtract(ITEM, JSON_PATH.content.timeCompleted);
/** The `execute` filter: only `execute` items carry nested tool calls. */
const EXECUTE_FILTER = jsonEquals(ITEM, JSON_PATH.content.name, 'execute');
/**
 * The nested row id: `messageId#itemIndex#n{nestedIndex}`. A nested entry has
 * no provider call id, so a stable unique one is synthesised — the modal keys
 * rows by `id` and a shared empty id collides (task #1503). Mirrors the
 * `messageId#index` content-item convention (schema.ts {@link mapContentRow}).
 */
const NESTED_ID_EXPR = `m.id || '#' || CAST(${CONTENT_ITEM_ALIAS}.key AS TEXT) || '#n' || CAST(${NESTED_TOOL_CALL_ALIAS}.key AS TEXT)`;
/** The `metadata.toolCalls` is-array guard (ADR D-5/E-2/E-4). */
const ARRAY_GUARD = nestedToolCallsArrayGuard(CONTENT_ITEM_ALIAS);

/**
 * The constant content-item predicate every read in this module shares, for the
 * requested mode: tool items only, plus the failed pair unless `all` was asked.
 * The failed pair comes from {@link FAILED_TOOL_STATUSES}, the single shared
 * definition of a failed tool call.
 */
function baseWhere(status: ToolCallStatus): string {
	const typePredicate = jsonEquals(ITEM, JSON_PATH.content.itemType, CONTENT_TYPE.tool);
	if (status === 'all') return typePredicate;
	return `${typePredicate} AND ${jsonIn(ITEM, JSON_PATH.content.status, FAILED_TOOL_STATUSES)}`;
}

/**
 * The nested content-item predicate for the UNION ALL branch: tool items that
 * are `execute` items with an array `metadata.toolCalls`, plus the failed pair
 * (on the nested status) unless `all` was asked.
 */
function baseWhereNested(status: ToolCallStatus): string {
	if (status === 'all') return '';
	return ` AND ${jsonIn(NESTED_ITEM, JSON_PATH.nestedToolCall.status, FAILED_TOOL_STATUSES)}`;
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
 *
 * `toolLabelExpr` and `errorExpr` parameterise the expressions so the same
 * filter shape serves both the top-level branch ({@link TOOL_LABEL_EXPR} /
 * {@link ERROR_EXPR}) and the nested branch ({@link NESTED_TOOL_LABEL_EXPR} /
 * `''` — nested entries carry no error text, so a non-empty search
 * intentionally matches no nested row).
 */
function buildFilters(
	filter: ToolErrorsFilter,
	toolLabelExpr: string,
	errorExpr: string
): {
	clause: string;
	params: Record<string, string>;
} {
	const clauses: string[] = [];
	const params: Record<string, string> = {};
	const tool = filter.tool?.trim() ?? '';
	if (tool !== '') {
		clauses.push(`${toolLabelExpr} = :tool`);
		params[':tool'] = tool;
	}
	const search = filter.search?.trim() ?? '';
	if (search !== '') {
		clauses.push(`${errorExpr} LIKE :q ESCAPE '\\'`);
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
 * `session_v2.id -> agent label` for the requested id set, one query per chunk.
 * A session with no row maps to `unknown`, matching the removed join's
 * `COALESCE(NULLIF(trim(session_v2.agent), ''), 'unknown')`.
 */
function agentBySession(sessionIds: readonly string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const id of sessionIds) map.set(id, UNKNOWN_LABEL);
	const db = getDb();
	for (const ids of chunk(sessionIds, IN_CHUNK_SIZE)) {
		const sql = `SELECT session_v2.id AS id, session_v2.agent AS agent
			FROM session_v2 WHERE session_v2.id IN (${idPlaceholders(ids.length)})`;
		const rows = db.query(sql).all(bindIds({}, ids)) as Row[];
		for (const row of rows) {
			const agent = toText(row.agent).trim();
			map.set(toText(row.id), agent === '' ? UNKNOWN_LABEL : agent);
		}
	}
	return map;
}

/** `$.state.input`/`output`: `null` for a NULL/blank value. */
function toNullableText(value: unknown): string | null {
	const text = toText(value);
	return text === '' ? null : text;
}

function mapRow(row: Row, agents: ReadonlyMap<string, string>): ToolErrorEntry {
	const tool = toText(row.tool);
	const sessionId = toText(row.session_id);
	return {
		id: toText(row.call_id),
		sessionId,
		at: toCount(row.at),
		agent: agents.get(sessionId) ?? UNKNOWN_LABEL,
		tool,
		status: toText(row.status),
		error: toText(row.error),
		input: toNullableText(row.input),
		output: toolOutputText(toText(row.output_raw)),
		endedAt: isBound(row.ended_at) ? row.ended_at : null,
		isMcp: isMcpTool(tool),
		isDelegation: tool === 'subagent'
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
	// Sort rows deterministically before mapping: newest first, then call_id
	// desc, then nested_key asc (the nested `json_each` index — stable ordering
	// for nested calls of one `execute` item; ADR D-5/E-6).
	const sorted = [...rows].sort((a, b) => {
		const atDiff = toCount(b.at) - toCount(a.at);
		if (atDiff !== 0) return atDiff;
		const aId = toText(a.call_id);
		const bId = toText(b.call_id);
		if (aId !== bId) return aId < bId ? 1 : -1;
		return toCount(a.nested_key) - toCount(b.nested_key);
	});
	const entries: ToolErrorEntry[] = [];
	for (const row of sorted) {
		const sessionId = toText(row.session_id);
		if (!allowed.has(sessionId)) continue;
		const entry = mapRow(row, agents);
		if (wantedAgent !== null && entry.agent !== wantedAgent) continue;
		entries.push(entry);
	}
	return entries;
}

/**
 * One global page of tool calls, newest first (`session_message.time_created`
 * desc, then the content item `$.id` desc). Returns `[]` for an empty id set;
 * `offset`/`limit` are assumed already clamped by the caller.
 */
export function listToolErrors(
	sessionIds: readonly string[],
	filter: ToolErrorsFilter,
	offset: number,
	limit: number
): ToolErrorEntry[] {
	if (sessionIds.length === 0 || limit <= 0) return [];
	const { clause, params } = buildFilters(filter, TOOL_LABEL_EXPR, ERROR_EXPR);
	const nestedClause = buildFilters(filter, NESTED_TOOL_LABEL_EXPR, `''`).clause;
	const where = baseWhere(filter.status ?? DEFAULT_TOOL_CALL_STATUS);
	const nestedWhere = baseWhereNested(filter.status ?? DEFAULT_TOOL_CALL_STATUS);
	const typeFilter = jsonEquals(ITEM, JSON_PATH.content.itemType, CONTENT_TYPE.tool);
	const allowed = new Set(sessionIds);
	// The agent map is built once for the whole id set, not per chunk.
	const agents = agentBySession(sessionIds);
	// Fetch the per-chunk newest `offset + limit`; their union contains the
	// global page (a row in the global top N is in its own chunk's top N).
	const cap = offset + limit;
	const collected: ToolErrorEntry[] = [];
	for (const ids of chunk(sessionIds, IN_CHUNK_SIZE)) {
		const sql = `
			SELECT call_id, session_id, at, tool, status, error, input, output_raw, ended_at, nested_key
			FROM (
				SELECT ${jsonExtract(ITEM, JSON_PATH.content.callId)} AS call_id,
					m.session_id AS session_id,
					m.time_created AS at,
					${TOOL_LABEL_EXPR} AS tool,
					${STATUS_EXPR} AS status,
					${ERROR_EXPR} AS error,
					${INPUT_EXPR} AS input,
					${CONTENT_EXPR} AS output_raw,
					${ENDED_EXPR} AS ended_at,
					-1 AS nested_key
				FROM session_message m, json_each(m.data, '${JSON_PATH.message.content}') AS ${CONTENT_ITEM_ALIAS}
				WHERE m.session_id IN (${idPlaceholders(ids.length)})
					AND m.type = '${MESSAGE_TYPE.assistant}' AND ${where}${clause}
				UNION ALL
				SELECT ${NESTED_ID_EXPR} AS call_id,
					m.session_id AS session_id,
					m.time_created AS at,
					${NESTED_TOOL_LABEL_EXPR} AS tool,
					${NESTED_STATUS_EXPR} AS status,
					'' AS error,
					${NESTED_INPUT_EXPR} AS input,
					NULL AS output_raw,
					NULL AS ended_at,
					${NESTED_TOOL_CALL_ALIAS}.key AS nested_key
				FROM session_message m, json_each(m.data, '${JSON_PATH.message.content}') AS ${CONTENT_ITEM_ALIAS}, ${nestedToolCallFrom(CONTENT_ITEM_ALIAS)}
				WHERE m.session_id IN (${idPlaceholders(ids.length)})
					AND m.type = '${MESSAGE_TYPE.assistant}' AND ${typeFilter}
					AND ${EXECUTE_FILTER} AND ${ARRAY_GUARD}${nestedWhere}${nestedClause}
			)
			ORDER BY at DESC, call_id DESC, nested_key ASC
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
	const { clause, params } = buildFilters(filter, TOOL_LABEL_EXPR, ERROR_EXPR);
	const nestedClause = buildFilters(filter, NESTED_TOOL_LABEL_EXPR, `''`).clause;
	const where = baseWhere(filter.status ?? DEFAULT_TOOL_CALL_STATUS);
	const nestedWhere = baseWhereNested(filter.status ?? DEFAULT_TOOL_CALL_STATUS);
	const typeFilter = jsonEquals(ITEM, JSON_PATH.content.itemType, CONTENT_TYPE.tool);
	let total = 0;
	for (const ids of chunk(sessionIds, IN_CHUNK_SIZE)) {
		const sql = `
			SELECT count(*) AS count
			FROM (
				SELECT 1
				FROM session_message m, json_each(m.data, '${JSON_PATH.message.content}') AS ${CONTENT_ITEM_ALIAS}
				WHERE m.session_id IN (${idPlaceholders(ids.length)})
					AND m.type = '${MESSAGE_TYPE.assistant}' AND ${where}${clause}
				UNION ALL
				SELECT 1
				FROM session_message m, json_each(m.data, '${JSON_PATH.message.content}') AS ${CONTENT_ITEM_ALIAS}, ${nestedToolCallFrom(CONTENT_ITEM_ALIAS)}
				WHERE m.session_id IN (${idPlaceholders(ids.length)})
					AND m.type = '${MESSAGE_TYPE.assistant}' AND ${typeFilter}
					AND ${EXECUTE_FILTER} AND ${ARRAY_GUARD}${nestedWhere}${nestedClause}
			)`;
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
	const nestedWhere = baseWhereNested(status);
	const typeFilter = jsonEquals(ITEM, JSON_PATH.content.itemType, CONTENT_TYPE.tool);
	const agents = new Set<string>();
	const allowed = new Set(sessionIds);
	const matched = new Set<string>();
	for (const ids of chunk(sessionIds, IN_CHUNK_SIZE)) {
		const sql = `
			SELECT session_id
			FROM (
				SELECT m.session_id AS session_id
				FROM session_message m, json_each(m.data, '${JSON_PATH.message.content}') AS ${CONTENT_ITEM_ALIAS}
				WHERE m.session_id IN (${idPlaceholders(ids.length)})
					AND m.type = '${MESSAGE_TYPE.assistant}' AND ${where}
				UNION ALL
				SELECT m.session_id AS session_id
				FROM session_message m, json_each(m.data, '${JSON_PATH.message.content}') AS ${CONTENT_ITEM_ALIAS}, ${nestedToolCallFrom(CONTENT_ITEM_ALIAS)}
				WHERE m.session_id IN (${idPlaceholders(ids.length)})
					AND m.type = '${MESSAGE_TYPE.assistant}' AND ${typeFilter}
					AND ${EXECUTE_FILTER} AND ${ARRAY_GUARD}${nestedWhere}
			)`;
		const rows = getDb().query(sql).all(bindIds({}, ids)) as Row[];
		for (const row of rows) {
			const id = toText(row.session_id);
			if (allowed.has(id)) matched.add(id);
		}
	}
	for (const [, agent] of agentBySession([...matched])) agents.add(agent);
	return [...agents].sort();
}
