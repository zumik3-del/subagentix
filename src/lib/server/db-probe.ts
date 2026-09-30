/**
 * Read-only opencode database signature probe (task #257, ADR §7.1).
 *
 * Shared by discovery and the `PUT /api/settings` warning path so the
 * "does this look like an opencode DB?" guardrail is defined once. It never
 * writes: the connection is `readonly`, `query_only` and short-timeout, and is
 * always closed. SQL lives in the query layer (`queries/health.ts`).
 *
 * V2 only (spec decision D-4): the signature is the presence of `session_v2`
 * and `session_message`; a V1 (`session`/`message`/`part`) or foreign DB
 * returns `null`.
 */
import { existsSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { countSessions, isV2Schema } from './queries/health';

export interface OpencodeDbProbe {
	path: string;
	sessions: number;
	mtimeMs: number;
}

/** Return probe metadata, or `null` when the path is missing/not a V2 opencode DB. */
export function probeOpencodeDb(path: string): OpencodeDbProbe | null {
	try {
		if (!existsSync(path)) return null;
		const stat = statSync(path);
		if (!stat.isFile() || stat.size <= 0) return null;

		const db = new Database(path, { readonly: true });
		try {
			db.exec('PRAGMA query_only = 1;');
			db.exec('PRAGMA busy_timeout = 250;');
			if (!isV2Schema(db)) return null;
			return { path, sessions: countSessions(db), mtimeMs: stat.mtimeMs };
		} finally {
			db.close();
		}
	} catch {
		return null;
	}
}
