/**
 * Tier-S dashboard aggregates plus the shared session-id resolver.
 *
 * The Tier-S loaders read only the small `session` table (~1.6k rows) plus, for
 * directory names, `project` when the live schema links it — no `message`,
 * `part` or `event` scan can enter those paths. {@link listSessionIds} resolves
 * the in-window session set that bounds the Tier-M (`message`) and Tier-P
 * (`part`) reads to those sessions, chunked under SQLite's variable limit.
 *
 * All caller values are bound parameters — no string interpolation. The period
 * window is a half-open `[from, to)` over `session.time_created`; a `null` bound
 * is unbounded (`period = all`). Values come from `schema.ts` helpers, so no
 * `json_extract` or JSON path literal is spelled out here.
 */
import { getDb } from '../db';
import { jsonExtract, JSON_PATH, tokenCounts, type Row } from '../schema';
import type { TokenCounts } from '../../model/token';
import { hasProjectLink } from './project-link';
import {
	DEFAULT_TOP_N,
	isBound,
	sanitizeLimit,
	toCount,
	toText,
	UNKNOWN_LABEL,
	type DashboardWindow
} from './dashboard-shared';

/** One UTC-day bucket of session counts (`{ day: 'YYYY-MM-DD', count }`). */
export interface DayCountRecord {
	day: string;
	count: number;
}

/** One named count group (agent, model, provider, …). */
export interface NamedCountRecord {
	name: string;
	count: number;
}

/** One directory group of the top-directories loader. */
export interface DirectoryCountRecord {
	directory: string;
	projectName: string | null;
	count: number;
}

/** Windowed totals over the `session` rollup columns. */
export interface SessionTotalsRecord {
	count: number;
	cost: number;
	tokens: TokenCounts;
}

const AGENT_EXPR = `COALESCE(NULLIF(trim(session.agent), ''), '${UNKNOWN_LABEL}')`;
const MODEL_EXPR = `COALESCE(NULLIF(trim(${jsonExtract(
	'session.model',
	JSON_PATH.session.modelId
)}), ''), '${UNKNOWN_LABEL}')`;
const PROVIDER_EXPR = `COALESCE(NULLIF(trim(${jsonExtract(
	'session.model',
	JSON_PATH.session.providerId
)}), ''), '${UNKNOWN_LABEL}')`;

/**
 * Build the shared `WHERE` clause over `session` from a window/scope. `extra`
 * predicates (constant SQL, never caller input) are ANDed in front. Returns the
 * SQL fragment plus the matching named bindings; an empty clause means no
 * predicates.
 */
function buildWhere(
	window: DashboardWindow,
	extra: readonly string[] = []
): { clause: string; params: Record<string, number | string> } {
	const clauses = [...extra];
	const params: Record<string, number | string> = {};
	if (isBound(window.from)) {
		clauses.push('session.time_created >= :from');
		params[':from'] = window.from;
	}
	if (isBound(window.to)) {
		clauses.push('session.time_created < :to');
		params[':to'] = window.to;
	}
	if (typeof window.directory === 'string' && window.directory !== '') {
		clauses.push('session.directory = :directory');
		params[':directory'] = window.directory;
	}
	return {
		clause: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
		params
	};
}

/**
 * Sessions per UTC calendar day, ascending. Buckets come from
 * `date(time_created/1000, 'unixepoch')`, i.e. the same UTC boundaries
 * `model/chart.ts` uses to densify the series, so no row can land in a day the
 * chart would place elsewhere. Only `session` is read.
 */
export function countSessionsByUtcDay(window: DashboardWindow): DayCountRecord[] {
	const filter = buildWhere(window, ['session.time_created IS NOT NULL']);
	const sql = `
		SELECT date(session.time_created / 1000, 'unixepoch') AS day,
			count(*) AS count
		FROM session${filter.clause}
		GROUP BY day
		ORDER BY day ASC`;
	const rows = getDb().query(sql).all(filter.params) as Row[];
	return rows
		.map((row) => ({ day: toText(row.day), count: toCount(row.count) }))
		.filter((row) => row.day !== '');
}

/** Sessions grouped by `session.agent`, count desc then name asc, top-N capped. */
export function countSessionsByAgent(
	window: DashboardWindow,
	limit = DEFAULT_TOP_N
): NamedCountRecord[] {
	const filter = buildWhere(window);
	const sql = `
		SELECT ${AGENT_EXPR} AS name, count(*) AS count
		FROM session${filter.clause}
		GROUP BY name
		ORDER BY count DESC, name ASC
		LIMIT :limit`;
	return toNamedCounts(sql, filter.params, limit);
}

/** Sessions grouped by `session.model.id`, count desc then name asc, top-N capped. */
export function countSessionsByModel(
	window: DashboardWindow,
	limit = DEFAULT_TOP_N
): NamedCountRecord[] {
	const filter = buildWhere(window);
	const sql = `
		SELECT ${MODEL_EXPR} AS name, count(*) AS count
		FROM session${filter.clause}
		GROUP BY name
		ORDER BY count DESC, name ASC
		LIMIT :limit`;
	return toNamedCounts(sql, filter.params, limit);
}

/** Sessions grouped by `session.model.providerID`, count desc then name asc, top-N capped. */
export function countSessionsByProvider(
	window: DashboardWindow,
	limit = DEFAULT_TOP_N
): NamedCountRecord[] {
	const filter = buildWhere(window);
	const sql = `
		SELECT ${PROVIDER_EXPR} AS name, count(*) AS count
		FROM session${filter.clause}
		GROUP BY name
		ORDER BY count DESC, name ASC
		LIMIT :limit`;
	return toNamedCounts(sql, filter.params, limit);
}

/**
 * Sessions grouped by directory, count desc then path asc, top-N capped. Blank
 * and NULL directories are dropped (the shared directory list filter treats an
 * empty value as "no filter", so such a group could not be scoped back).
 *
 * The `project.name` join is added only when the live schema links sessions to
 * projects, mirroring `listDirectories`; otherwise `projectName` stays `null`.
 */
export function countSessionsByDirectory(
	window: DashboardWindow,
	limit = DEFAULT_TOP_N
): DirectoryCountRecord[] {
	const linked = hasProjectLink();
	const projectColumn = linked ? 'max(project.name) AS project_name' : 'NULL AS project_name';
	const join = linked ? ' LEFT JOIN project ON project.id = session.project_id' : '';
	const filter = buildWhere(window, [
		'session.directory IS NOT NULL',
		"session.directory <> ''"
	]);
	const sql = `
		SELECT session.directory AS directory, ${projectColumn}, count(*) AS count
		FROM session${join}${filter.clause}
		GROUP BY session.directory
		ORDER BY count DESC, session.directory ASC
		LIMIT :limit`;
	const params = { ...filter.params, ':limit': sanitizeLimit(limit) };
	const rows = getDb().query(sql).all(params) as Row[];
	return rows.map((row) => {
		const name = toText(row.project_name).trim();
		return {
			directory: toText(row.directory),
			projectName: name === '' ? null : name,
			count: toCount(row.count)
		};
	});
}

/**
 * Windowed totals over `session`: row count, summed `cost` and the five summed
 * token columns. A single aggregate row, never a per-row fetch.
 */
export function aggregateSessionTotals(window: DashboardWindow): SessionTotalsRecord {
	const filter = buildWhere(window);
	const sql = `
		SELECT count(*) AS count,
			COALESCE(sum(session.cost), 0) AS cost,
			COALESCE(sum(session.tokens_input), 0) AS tok_input,
			COALESCE(sum(session.tokens_output), 0) AS tok_output,
			COALESCE(sum(session.tokens_reasoning), 0) AS tok_reasoning,
			COALESCE(sum(session.tokens_cache_read), 0) AS cache_read,
			COALESCE(sum(session.tokens_cache_write), 0) AS cache_write
		FROM session${filter.clause}`;
	const row = (getDb().query(sql).get(filter.params) as Row | null) ?? {};
	return {
		count: toCount(row.count),
		cost: toCount(row.cost),
		tokens: tokenCounts(row)
	};
}

/** Run a `SELECT name, count …` group query and map it to {@link NamedCountRecord}. */
function toNamedCounts(
	sql: string,
	params: Record<string, number | string>,
	limit: number
): NamedCountRecord[] {
	const bound = { ...params, ':limit': sanitizeLimit(limit) };
	const rows = getDb().query(sql).all(bound) as Row[];
	return rows.map((row) => ({ name: toText(row.name), count: toCount(row.count) }));
}

/**
 * Ids of the sessions matching the window/scope. Used to bound the Tier-M
 * `message` and Tier-P `part` reads to the in-window session set. Without `max`
 * the order is not specified (both aggregates are order-independent) and every
 * match is returned. With `max`, the most recent sessions (by `time_created`)
 * are returned first, capped at `max` — the Tier-P ceiling that keeps a
 * `period=all` read bounded. A non-finite `max` degrades to an empty set rather
 * than an unbounded scan.
 */
export function listSessionIds(window: DashboardWindow, max?: number): string[] {
	const filter = buildWhere(window);
	const capped = max !== undefined;
	const cap = capped ? (Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0) : 0;
	const order = capped ? ' ORDER BY session.time_created DESC, session.id DESC' : '';
	const limit = capped ? ' LIMIT :max' : '';
	const params = capped ? { ...filter.params, ':max': cap } : filter.params;
	const rows = getDb()
		.query(`SELECT session.id AS id FROM session${filter.clause}${order}${limit}`)
		.all(params) as Row[];
	return rows.map((row) => toText(row.id)).filter((id) => id !== '');
}
