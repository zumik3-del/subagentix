/**
 * Session-scoped read queries (ADR §6.1, V2 schema).
 *
 * The session reads target `session_v2` and use only indexed access
 * (`session_v2_parent_idx` for the subtree, `session_v2_project_idx` for the
 * project join). The delegation edges read the `subagent` `data.content[]` items
 * of `session_message` (`session_v2.parent_id` owns the tree, decision D-5). All
 * values are bound parameters — no string interpolation.
 */
import { getDb } from '../db';
import {
	contentColumns,
	contentTextItems,
	jsonEquals,
	mapContentRow,
	mapSessionRow,
	mapSessionSummaryRow,
	sessionColumns,
	CONTENT_TYPE,
	JSON_PATH,
	MESSAGE_TYPE,
	type ContentRecord,
	type DelegationRecord,
	type Row,
	type SessionRecord,
	type SessionSummaryRecord
} from '../schema';
import { usageFromCounts } from '../../model/token';
import type { DirectorySummary, SessionSummary } from '../../model/types';

/** A subtree row: its depth relative to the requested root. */
export interface SessionSubtreeRecord extends SessionRecord {
	depth: number;
}

/** Clamp a caller-supplied page size to a safe integer within `[0, max]`. */
function sanitizeLimit(limit: number, max = 500): number {
	if (!Number.isFinite(limit)) return 0;
	return Math.min(max, Math.max(0, Math.floor(limit)));
}

/** Clamp a caller-supplied page offset to a safe integer `>= 0`. */
function sanitizeOffset(offset: number): number {
	if (!Number.isFinite(offset)) return 0;
	return Math.max(0, Math.floor(offset));
}

/** Whether a session id exists (`session_v2` primary-key lookup). */
export function sessionExists(sessionId: string): boolean {
	const row = getDb()
		.query('SELECT 1 AS present FROM session_v2 WHERE session_v2.id = :sid')
		.get({ ':sid': sessionId }) as Row | null;
	return row !== null;
}

/** Escape LIKE wildcards so a raw search term matches literally (`ESCAPE '\'`). */
function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Case-insensitive substring filter over a session's `title`, `id` and
 * `directory` (SQLite `LIKE` is ASCII-case-insensitive). Returns an empty
 * clause when `query` is blank. The pattern is always a bound parameter and
 * caller-supplied `%`/`_`/`\` are escaped first, so the search term matches
 * literally.
 */
function buildSearchFilter(query: string | undefined): { clause: string; pattern: string | null } {
	const term = query?.trim() ?? '';
	if (term === '') return { clause: '', pattern: null };
	return {
		clause: ` AND (session_v2.title LIKE :q ESCAPE '\\' OR session_v2.id LIKE :q ESCAPE '\\' OR session_v2.directory LIKE :q ESCAPE '\\')`,
		pattern: `%${escapeLike(term)}%`
	};
}

/**
 * Recent root sessions for the session list (ADR §6.1). `:limit` and `:offset`
 * are bound parameters.
 *
 * `directory` is optional; when given it filters in SQL (never post-filtered by
 * the caller) and uses the same `session_v2.directory` scope as the spec. `offset`
 * (>= 0, default 0) pages the newest-first list; an out-of-range offset returns
 * an empty array rather than throwing. `query` is an optional case-insensitive
 * substring search over title/id/directory (see `buildSearchFilter`).
 *
 * Note: bun:sqlite binds named parameters by their full token, including the
 * `:` prefix (`{ ':limit': n }`), which is why the binding objects below use
 * prefixed keys.
 */
export function listRecentRootSessions(
	limit: number,
	directory?: string,
	offset = 0,
	query?: string
): SessionSummary[] {
	const columns = sessionColumns('session_v2');
	const hasDirectory = directory !== undefined && directory !== '';
	const directoryFilter = hasDirectory ? ' AND session_v2.directory = :directory' : '';
	const search = buildSearchFilter(query);
	const sql = `
		SELECT ${columns},
			(SELECT count(*) FROM session_v2 child WHERE child.parent_id = session_v2.id) AS child_count
		FROM session_v2
		WHERE session_v2.parent_id IS NULL${directoryFilter}${search.clause}
		ORDER BY session_v2.time_created DESC
		LIMIT :limit OFFSET :offset`;
	const params: Record<string, string | number> = {
		':limit': sanitizeLimit(limit),
		':offset': sanitizeOffset(offset)
	};
	if (hasDirectory) params[':directory'] = directory;
	if (search.pattern !== null) params[':q'] = search.pattern;
	const rows = getDb().query(sql).all(params) as Row[];
	return rows.map(mapSessionSummaryRow).map(toSessionSummary);
}

/**
 * Number of root sessions matching the list filter (ADR §6.1), used by the
 * session list page to clamp an out-of-range `offset` to the last page and to
 * report an honest `hasNext`. A single indexed count, never per-row.
 */
export function countRecentRootSessions(directory?: string, query?: string): number {
	const hasDirectory = directory !== undefined && directory !== '';
	const directoryFilter = hasDirectory ? ' AND session_v2.directory = :directory' : '';
	const search = buildSearchFilter(query);
	const sql = `SELECT count(*) AS count FROM session_v2 WHERE session_v2.parent_id IS NULL${directoryFilter}${search.clause}`;
	const params: Record<string, string> = {};
	if (hasDirectory) params[':directory'] = directory;
	if (search.pattern !== null) params[':q'] = search.pattern;
	const row = getDb().query(sql).get(params) as Row | null;
	const count = row === null ? 0 : Number(row.count);
	return Number.isFinite(count) ? count : 0;
}

/**
 * Root-session directories for the sidebar tree, newest activity first
 * (task #212), each carrying its opencode project name (task #239).
 *
 * `session_v2.parent_id IS NULL` keeps this on `session_v2_parent_idx`; the
 * `GROUP BY` / `max()` touch only `session_v2` and `project` columns, never the
 * JSON payload. Blank directories are dropped because the
 * shared `directory` list filter treats an empty value as "no filter", so such
 * a group could not be paged back through `/api/sessions?directory=`.
 */
export function listDirectories(): DirectorySummary[] {
	// A directory maps to a single project, so `max(project.name)` is just "a
	// non-null name if any row has one"; it also satisfies the aggregate rule.
	// `session_v2.project_id` is `NOT NULL` and `project` always exists in V2,
	// so the project join is unconditional (spec decision D-4: no probe).
	const sql = `
		SELECT session_v2.directory AS directory,
			max(project.name) AS project_name,
			count(*) AS session_count,
			max(session_v2.time_updated) AS updated_at
		FROM session_v2
		LEFT JOIN project ON project.id = session_v2.project_id
		WHERE session_v2.parent_id IS NULL
			AND session_v2.directory IS NOT NULL
			AND session_v2.directory <> ''
		GROUP BY session_v2.directory
		ORDER BY updated_at DESC, session_v2.directory ASC`;
	const rows = getDb().query(sql).all() as Row[];
	return rows.map(toDirectorySummary);
}

/** Map one `listDirectories` row to the shared `DirectorySummary` DTO. */
function toDirectorySummary(row: Row): DirectorySummary {
	const count = Number(row.session_count);
	const updatedAt = Number(row.updated_at);
	const name = typeof row.project_name === 'string' ? row.project_name.trim() : '';
	return {
		directory: typeof row.directory === 'string' ? row.directory : String(row.directory ?? ''),
		projectName: name === '' ? null : name,
		sessionCount: Number.isFinite(count) ? count : 0,
		updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
	};
}

/** Map a session rollup row to the shared `SessionSummary` DTO. */
export function toSessionSummary(record: SessionSummaryRecord): SessionSummary {
	return {
		id: record.id,
		title: record.title,
		agent: record.agent ?? 'unknown',
		directory: record.directory,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		usage: usageFromCounts(record.usage, record.cost),
		childCount: record.childCount
	};
}

/**
 * Full subtree of a root session, including the root itself (ADR §6.1).
 *
 * The recursive CTE carries a materialized `path` and refuses to revisit a
 * session already on the path, so a corrupt `parent_id` cycle terminates
 * instead of looping forever.
 */
export function getSessionSubtree(rootId: string): SessionSubtreeRecord[] {
	const sql = `
		WITH RECURSIVE subtree(id, depth, path) AS (
			SELECT :rootId, 0, '/' || :rootId || '/'
			UNION ALL
			SELECT child.id, parent.depth + 1, parent.path || child.id || '/'
			FROM session_v2 child
			JOIN subtree parent ON child.parent_id = parent.id
			WHERE instr(parent.path, '/' || child.id || '/') = 0
		)
		SELECT ${sessionColumns('session_v2')}, subtree.depth AS depth
		FROM session_v2
		JOIN subtree ON subtree.id = session_v2.id
		ORDER BY subtree.depth, session_v2.time_created`;
	const rows = getDb().query(sql).all({ ':rootId': rootId }) as Row[];
	return rows.map((row) => {
		const depth = typeof row.depth === 'number' ? row.depth : Number(row.depth);
		return { ...mapSessionRow(row), depth: Number.isFinite(depth) ? depth : 0 };
	});
}

/** `data.content[].name` of the delegation tool (V2's `subagent`, formerly `task`). */
const SUBAGENT_TOOL_NAME = 'subagent';

/**
 * The `subagent`-item predicate of a delegation read: a `tool` content item
 * whose `name` is `subagent`, resolved against the `json_each` alias `item`.
 */
function subagentItemFilter(): string {
	return `${jsonEquals('item.value', JSON_PATH.content.itemType, CONTENT_TYPE.tool)} AND ${jsonEquals(
		'item.value',
		JSON_PATH.content.name,
		SUBAGENT_TOOL_NAME
	)}`;
}

/**
 * Length of a `subagent` item's joined `state.content[]` text (spec OQ-10): only
 * `type='text'` output items count, so a base64 `file` item never inflates the
 * result size (spec §3.10/E-10). V2 dropped `state.output` (spec §3.10); the
 * shared {@link contentTextItems} walk replaces the V1 `state.output.length`.
 */
function contentTextBytes(rawContent: string | null): number {
	return contentTextItems(rawContent).reduce((total, text) => total + text.length, 0);
}

/**
 * Map one `subagent` content item to the internal edge record. The item has no
 * row id, so its identity is the synthesised `messageId#index` (spec §3.6); the
 * child lives in `state.metadata.sessionID` and the subagent type in
 * `state.input.agent` (spec §P3/AC3.a).
 */
function toDelegationRecord(item: ContentRecord): DelegationRecord {
	return {
		id: item.id,
		sessionId: item.sessionId,
		messageId: item.messageId,
		createdAt: item.timeCreated ?? 0,
		// V2 has no `state.metadata.parentSessionId`: the edge's parent is the
		// carrying message's session (`item.sessionId`), decision D-5. The field
		// stays `null` and is no longer read by the edge mapper.
		parentSessionId: null,
		childSessionId: item.metadataSessionId,
		subagentType: item.agent,
		status: item.status ?? 'unknown',
		error: item.errorMessage ?? item.errorType,
		startedAt: item.timeRan ?? item.timeCreated,
		endedAt: item.timeCompleted,
		resultBytes: contentTextBytes(item.content),
		description: item.description,
		prompt: item.prompt
	};
}

/**
 * Delegation edges of one session (ADR §6.1): every `data.content[]` item with
 * `name='subagent'` of the session's `assistant` messages is one edge (V2's
 * `subagent` tool item replaced V1's `part.tool='task'`, spec §P3). The
 * `session_id` predicate keeps the read on
 * `session_message_session_type_seq_idx`; `json_each` then walks only that
 * session's assistant payloads (decision D-3). `synthetic` messages are never a
 * source (decision D-6).
 */
export function getDelegationEdges(sessionId: string): DelegationRecord[] {
	const sql = `
		SELECT ${contentColumns('item', 'm')}
		FROM session_message m, json_each(m.data, '${JSON_PATH.message.content}') AS item
		WHERE m.session_id = :sid
			AND m.type = '${MESSAGE_TYPE.assistant}'
			AND ${subagentItemFilter()}
		ORDER BY m.seq, item.key`;
	const rows = getDb().query(sql).all({ ':sid': sessionId }) as Row[];
	return rows.map(mapContentRow).map(toDelegationRecord);
}

/**
 * Delegation edges of a root session's whole subtree in ONE query (task #386):
 * the recursive CTE walks `session_v2.parent_id` (`session_v2_parent_idx`) and
 * the join resolves each subtree id through its `subagent` content items,
 * replacing the per-session N+1. Ordered by session then message order so
 * callers can group without re-sorting. The `path` guard terminates a corrupt
 * `parent_id` cycle exactly like {@link getSessionSubtree}.
 *
 * Reconciliation policy (decision D-5/OQ-4): `parent_id` owns the tree (the
 * CTE), the `subagent` item owns the edge. When the item names a child the
 * walked tree does not contain, the edge is still returned — never silently
 * dropped — and a warning is logged naming the edge, its parent and the child.
 */
export function getSubtreeDelegationEdges(rootId: string): DelegationRecord[] {
	const sql = `
		WITH RECURSIVE subtree(id, path) AS (
			SELECT :rootId, '/' || :rootId || '/'
			UNION ALL
			SELECT child.id, parent.path || child.id || '/'
			FROM session_v2 child
			JOIN subtree parent ON child.parent_id = parent.id
			WHERE instr(parent.path, '/' || child.id || '/') = 0
		)
		SELECT ${contentColumns('item', 'm')}
		FROM session_message m
		JOIN json_each(m.data, '${JSON_PATH.message.content}') AS item
		JOIN subtree ON subtree.id = m.session_id
		WHERE m.type = '${MESSAGE_TYPE.assistant}'
			AND ${subagentItemFilter()}
		ORDER BY m.session_id, m.seq, item.key`;
	const rows = getDb().query(sql).all({ ':rootId': rootId }) as Row[];
	const edges = rows.map(mapContentRow).map(toDelegationRecord);

	// D-5 reconciliation: keep every edge, but log the ones whose child is
	// outside the parent_id tree the CTE walked.
	const subtreeIds = new Set(getSessionSubtree(rootId).map((session) => session.id));
	for (const edge of edges) {
		if (edge.childSessionId !== null && !subtreeIds.has(edge.childSessionId)) {
			console.warn(
				`[sessions] delegation edge ${edge.id} (parent ${edge.sessionId}) points at child ` +
					`${edge.childSessionId}, which is not in the ${rootId} parent_id subtree (D-5).`
			);
		}
	}
	return edges;
}
