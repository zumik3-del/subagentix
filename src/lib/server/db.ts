import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { countSessions } from './queries/health';
import { onSettingsChange, resolveDbPath } from './settings';

export { resolveDbPath };

let conn: Database | null = null;
let connPath: string | null = null;

/**
 * Drop the cached connection (if any). `close()` on a read-only WAL handle
 * cannot checkpoint, so this is not a write.
 */
export function resetDbConnection(): void {
	if (conn) {
		try {
			conn.close();
		} catch {
			// Already closed.
		}
	}
	conn = null;
	connPath = null;
}

/**
 * Open the opencode database in strict read-only mode, keyed by the effective
 * path. Re-resolves the path on every call so a settings change applies live.
 *
 * Guard rails (ADR §4.1 / task #181):
 * - `readonly: true` => SQLITE_OPEN_READONLY.
 * - `PRAGMA query_only = 1` => accidental INSERT/UPDATE/DDL throws SQLITE_READONLY.
 * - `PRAGMA busy_timeout = 5000` => tolerate a rare concurrent checkpoint.
 * - NEVER `immutable=1` (bypasses the live WAL -> stale snapshot).
 * - NEVER `journal_mode` / `wal_checkpoint` / `VACUUM` or any other write.
 *
 * Queries run in autocommit: no transaction is held across an `await`.
 */
export function getDb(): Database {
	const path = resolveDbPath();
	if (conn && connPath === path) return conn;
	if (conn) resetDbConnection();

	if (!existsSync(path)) {
		throw new Error(
			`opencode database not found at "${path}". ` +
				`Start opencode first or point the DB path at the correct location.`
		);
	}

	try {
		const db = new Database(path, { readonly: true });
		db.exec('PRAGMA query_only = 1;');
		db.exec('PRAGMA busy_timeout = 5000;');
		conn = db;
		connPath = path;
		return db;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Cannot open the opencode database read-only at "${path}": ${message}. ` +
				`Ensure opencode is running so the -wal/-shm files are readable.`
		);
	}
}

export interface HealthReport {
	ok: true;
	dbPath: string;
	sessions: number;
}

/**
 * Startup/read self-check: open read-only and read a known row (session count)
 * without writing anything. Throws a clear error on failure. The SQL lives in
 * the query layer (`queries/health.ts`); this is the DB-path-owning wrapper.
 */
export function healthCheck(): HealthReport {
	const dbPath = resolveDbPath();
	return { ok: true, dbPath, sessions: countSessions(getDb()) };
}

// A settings change that moves the effective path must drop the stale handle;
// the next `getDb()` reopens the new path. One direction only: db -> settings.
onSettingsChange(() => {
	if (connPath !== null && connPath !== resolveDbPath()) resetDbConnection();
});
