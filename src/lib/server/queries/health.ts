/**
 * Read-only health queries (ADR §7.1). Lives in the query layer so `db.ts`
 * owns only the connection, never SQL.
 */
import type { Database } from 'bun:sqlite';

/** Count sessions on an open connection without reading any content (V2). */
export function countSessions(db: Database): number {
	const row = db.query('SELECT count(*) AS count FROM session_v2').get() as {
		count: number;
	} | null;
	return row?.count ?? 0;
}

/**
 * Does this DB carry the opencode V2 signature (`session_v2` +
 * `session_message`)? V1 and non-opencode DBs fail this check (spec decision
 * D-4): there is no V1 compatibility path.
 */
export function isV2Schema(db: Database): boolean {
	const row = db
		.query(
			"SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('session_v2','session_message')"
		)
		.get() as { count: number } | null;
	return (row?.count ?? 0) === 2;
}
