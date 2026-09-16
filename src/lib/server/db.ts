import { existsSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { countSessions } from './queries/health';
import { onSettingsChange, resolveDbPath } from './settings';

export { resolveDbPath };

let conn: Database | null = null;
let connPath: string | null = null;

/**
 * Monotonic handle generation, bumped on every reset. Read caches fold it into
 * their key, so a path swap or explicit reset can never reuse an old snapshot.
 */
let generation = 0;
const resetListeners = new Set<() => void>();

/**
 * Subscribe to DB-handle resets (path change or explicit `resetDbConnection`).
 * Listeners must be cheap and must NOT call `getDb()`: a reset can run while
 * `getDb()` is mid-open, and re-entering it would leak a second handle.
 */
export function onDbReset(listener: () => void): () => void {
	resetListeners.add(listener);
	return () => {
		resetListeners.delete(listener);
	};
}

function notifyDbReset(): void {
	generation++;
	for (const listener of [...resetListeners]) {
		try {
			listener();
		} catch (error) {
			// A subscriber must never break a successful reset.
			console.warn('[db] reset listener failed:', error);
		}
	}
}

/**
 * Drop the cached connection (if any). `close()` on a read-only WAL handle
 * cannot checkpoint, so this is not a write. Resets notify subscribers so
 * read-through caches drop snapshots tied to the closed handle.
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
	notifyDbReset();
}

/**
 * `mtimeMs:size` of a file, or `missing` when it does not exist. Used only for
 * read-cache invalidation, never to open or modify anything.
 */
function fileState(path: string): string {
	try {
		const stats = statSync(path);
		return `${Math.trunc(stats.mtimeMs)}:${stats.size}`;
	} catch {
		return 'missing';
	}
}

/**
 * Opaque snapshot token for read-through caches (task #386). It changes when
 * the resolved path changes, the handle is reset, the DB or its `-wal` sidecar
 * advances, or another connection commits.
 *
 * In WAL mode a commit does NOT touch the main file's mtime/size, so the file
 * state alone is not enough: `PRAGMA data_version` is the reliable signal — it
 * is a read-only pragma that flips when any other connection commits. Reads
 * and `stat` only; never a write, checkpoint or VACUUM.
 */
export function dbStateToken(): string {
	const path = resolveDbPath();
	const db = getDb();
	const row = db.query('PRAGMA data_version').get() as { data_version?: number } | null;
	const dataVersion = row?.data_version ?? 0;
	return `${generation}|${path}|${fileState(path)}|${fileState(`${path}-wal`)}|${dataVersion}`;
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
