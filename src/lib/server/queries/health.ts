/**
 * Read-only health queries (ADR §7.1). Lives in the query layer so `db.ts`
 * owns only the connection, never SQL.
 */
import type { Database } from 'bun:sqlite';

/** Count sessions on an open connection without reading any content. */
export function countSessions(db: Database): number {
	const row = db.query('SELECT count(*) AS count FROM session').get() as {
		count: number;
	} | null;
	return row?.count ?? 0;
}

/** How many of `session`/`message`/`part` exist (opencode signature: 3). */
export function countOpencodeSignatureTables(db: Database): number {
	const row = db
		.query(
			"SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('session','message','part')"
		)
		.get() as { count: number } | null;
	return row?.count ?? 0;
}
