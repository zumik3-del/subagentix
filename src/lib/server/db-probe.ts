/**
 * Read-only opencode database signature probe (task #257, ADR §7.1).
 *
 * Shared by discovery and the `PUT /api/settings` warning path so the
 * "does this look like an opencode DB?" guardrail is defined once. It never
 * writes: the connection is `readonly`, `query_only` and short-timeout, and is
 * always closed. SQL lives in the query layer (`queries/health.ts`).
 */
import { existsSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { countOpencodeSignatureTables, countSessions } from './queries/health';

export interface OpencodeDbProbe {
	path: string;
	sessions: number;
	mtimeMs: number;
}

/** Return probe metadata, or `null` when the path is missing/not an opencode DB. */
export function probeOpencodeDb(path: string): OpencodeDbProbe | null {
	try {
		if (!existsSync(path)) return null;
		const stat = statSync(path);
		if (!stat.isFile() || stat.size <= 0) return null;

		const db = new Database(path, { readonly: true });
		try {
			db.exec('PRAGMA query_only = 1;');
			db.exec('PRAGMA busy_timeout = 250;');
			if (countOpencodeSignatureTables(db) !== 3) return null;
			return { path, sessions: countSessions(db), mtimeMs: stat.mtimeMs };
		} finally {
			db.close();
		}
	} catch {
		return null;
	}
}
