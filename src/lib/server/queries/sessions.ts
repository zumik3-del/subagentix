/**
 * Session-scoped read queries (ADR §6.1).
 *
 * Uses only indexed access: `session_parent_idx` for the subtree, and the
 * per-session `part_session_idx` for delegation edges (never a full `part`
 * scan). All values are bound parameters — no string interpolation.
 */
import { getDb } from '../db';
import {
	jsonEquals,
	mapDelegationRow,
	mapSessionRow,
	mapSessionSummaryRow,
	partColumns,
	sessionColumns,
	JSON_PATH,
	PART_TYPE,
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

/** Whether a session id exists (`session` primary-key lookup). */
export function sessionExists(sessionId: string): boolean {
	const row = getDb()
		.query('SELECT 1 AS present FROM session WHERE session.id = :sid')
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
		clause: ` AND (session.title LIKE :q ESCAPE '\\' OR session.id LIKE :q ESCAPE '\\' OR session.directory LIKE :q ESCAPE '\\')`,
		pattern: `%${escapeLike(term)}%`
	};
}

/**
 * Recent root sessions for the session list (ADR §6.1). `:limit` and `:offset`
 * are bound parameters.
 *
 * `directory` is optional; when given it filters in SQL (never post-filtered by
 * the caller) and uses the same `session.directory` scope as the spec. `offset`
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
	const columns = sessionColumns('session');
	const hasDirectory = directory !== undefined && directory !== '';
	const directoryFilter = hasDirectory ? ' AND session.directory = :directory' : '';
	const search = buildSearchFilter(query);
	const sql = `
		SELECT ${columns},
			(SELECT count(*) FROM session child WHERE child.parent_id = session.id) AS child_count
		FROM session
		WHERE session.parent_id IS NULL${directoryFilter}${search.clause}
		ORDER BY session.time_created DESC
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
	const directoryFilter = hasDirectory ? ' AND session.directory = :directory' : '';
	const search = buildSearchFilter(query);
	const sql = `SELECT count(*) AS count FROM session WHERE session.parent_id IS NULL${directoryFilter}${search.clause}`;
	const params: Record<string, string> = {};
	if (hasDirectory) params[':directory'] = directory;
	if (search.pattern !== null) params[':q'] = search.pattern;
	const row = getDb().query(sql).get(params) as Row | null;
	const count = row === null ? 0 : Number(row.count);
	return Number.isFinite(count) ? count : 0;
}

/**
 * Whether the live DB links sessions to projects (`project` table plus a
 * `session.project_id` column). opencode's schema is not guaranteed, so the
 * join is skipped when either is absent and `projectName` stays `null`. The
 * probe uses only read-only metadata queries (`sqlite_master`, `PRAGMA
 * table_info`).
 *
 * Cached per connection, not per process: a stable `dbPath` keeps returning the
 * same `Database` from `getDb()` and is probed exactly once, while a settings
 * `dbPath` change makes `getDb()` drop and reopen the handle, so the next query
 * re-probes the new schema instead of trusting a stale result.
 */
let projectLink: boolean | null = null;
let projectLinkDb: ReturnType<typeof getDb> | null = null;

function hasProjectLink(): boolean {
	try {
		const db = getDb();
		if (db === projectLinkDb && projectLink !== null) return projectLink;
		projectLinkDb = db;
		const table = db
			.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'project'")
			.get() as Row | null;
		if (table === null) {
			projectLink = false;
			return false;
		}
		const columns = db.query('PRAGMA table_info(session)').all() as Row[];
		projectLink = columns.some((column) => column.name === 'project_id');
	} catch {
		// A missing/older schema must degrade to "no project name", never throw.
		projectLink = false;
	}
	return projectLink;
}

/**
 * Root-session directories for the sidebar tree, newest activity first
 * (task #212), each carrying its opencode project name when the schema links
 * one (task #239).
 *
 * `session.parent_id IS NULL` keeps this on `session_parent_idx`; the
 * `GROUP BY` / `max()` touch only `session` and (when present) `project`
 * columns, never `part`/`event`. Blank directories are dropped because the
 * shared `directory` list filter treats an empty value as "no filter", so such
 * a group could not be paged back through `/api/sessions?directory=`.
 */
export function listDirectories(): DirectorySummary[] {
	const linked = hasProjectLink();
	// A directory maps to a single project, so `max(project.name)` is just "a
	// non-null name if any row has one"; it also satisfies the aggregate rule.
	const projectColumn = linked ? 'max(project.name) AS project_name' : 'NULL AS project_name';
	const join = linked ? 'LEFT JOIN project ON project.id = session.project_id' : '';
	const sql = `
		SELECT session.directory AS directory,
			${projectColumn},
			count(*) AS session_count,
			max(session.time_updated) AS updated_at
		FROM session
		${join}
		WHERE session.parent_id IS NULL
			AND session.directory IS NOT NULL
			AND session.directory <> ''
		GROUP BY session.directory
		ORDER BY updated_at DESC, session.directory ASC`;
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
			FROM session child
			JOIN subtree parent ON child.parent_id = parent.id
			WHERE instr(parent.path, '/' || child.id || '/') = 0
		)
		SELECT ${sessionColumns('session')}, subtree.depth AS depth
		FROM session
		JOIN subtree ON subtree.id = session.id
		ORDER BY subtree.depth, session.time_created`;
	const rows = getDb().query(sql).all({ ':rootId': rootId }) as Row[];
	return rows.map((row) => {
		const depth = typeof row.depth === 'number' ? row.depth : Number(row.depth);
		return { ...mapSessionRow(row), depth: Number.isFinite(depth) ? depth : 0 };
	});
}

/**
 * Delegation edges (`tool='task'` parts) of one session (ADR §6.1). The
 * `session_id` predicate keeps this on `part_session_idx`; `json_extract`
 * filters only the rows of that session.
 */
export function getDelegationEdges(sessionId: string): DelegationRecord[] {
	const typeFilter = jsonEquals('part.data', JSON_PATH.part.type, PART_TYPE.tool);
	const toolFilter = jsonEquals('part.data', JSON_PATH.part.tool, 'task');
	const sql = `
		SELECT ${partColumns('part')}
		FROM part
		WHERE part.session_id = :sid AND ${typeFilter} AND ${toolFilter}
		ORDER BY part.time_created, part.id`;
	const rows = getDb().query(sql).all({ ':sid': sessionId }) as Row[];
	return rows.map(mapDelegationRow);
}

/**
 * Delegation edges (`tool='task'`) of a root session's whole subtree in ONE
 * query (task #386): the recursive CTE walks `session_parent_idx` and the join
 * resolves each subtree id through `part_session_idx`, replacing the
 * per-session N+1. Ordered by session then time so callers can group without
 * re-sorting. The `path` guard terminates a corrupt `parent_id` cycle exactly
 * like {@link getSessionSubtree}.
 */
export function getSubtreeDelegationEdges(rootId: string): DelegationRecord[] {
	const typeFilter = jsonEquals('part.data', JSON_PATH.part.type, PART_TYPE.tool);
	const toolFilter = jsonEquals('part.data', JSON_PATH.part.tool, 'task');
	const sql = `
		WITH RECURSIVE subtree(id, path) AS (
			SELECT :rootId, '/' || :rootId || '/'
			UNION ALL
			SELECT child.id, parent.path || child.id || '/'
			FROM session child
			JOIN subtree parent ON child.parent_id = parent.id
			WHERE instr(parent.path, '/' || child.id || '/') = 0
		)
		SELECT ${partColumns('part')}
		FROM part
		JOIN subtree ON subtree.id = part.session_id
		WHERE ${typeFilter} AND ${toolFilter}
		ORDER BY part.session_id, part.time_created, part.id`;
	const rows = getDb().query(sql).all({ ':rootId': rootId }) as Row[];
	return rows.map(mapDelegationRow);
}
