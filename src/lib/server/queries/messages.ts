/**
 * Session-scoped message and content-item reads (ADR §6.2–6.3, V2 schema).
 *
 * V2 removed the `message` and `part` tables (spec 2026-09-30 §2.1): every read
 * now targets `session_message` (role = the `type` column, order = the `seq`
 * column) and the former `part` rows are the `data.content[]` items walked with
 * `json_each(m.data, '$.content')`. Content items have no row id, so their
 * identity is `(messageId, index)` (spec §3.6/G-6).
 *
 * Every query keeps a session predicate so it stays on
 * `session_message_session_type_seq_idx`; the content reads additionally keep
 * the session-id filter (decision D-3) so `json_each` only ever walks the
 * in-scope assistant rows. The content reads accept an optional `message_id`
 * scope (task #386) so a scoped turn never loads another turn's items into JS.
 */
import { getDb } from '../db';
import {
	contentColumns,
	jsonEquals,
	jsonExtract,
	jsonIn,
	mapContentRow,
	mapMessageRow,
	mapTurnSummaryRow,
	messageColumns,
	CONTENT_TYPE,
	MESSAGE_TYPE,
	JSON_PATH,
	type ContentRecord,
	type MessageRecord,
	type Row,
	type TurnSummaryRecord
} from '../schema';

/**
 * SQL fragment scoping a content read to an explicit owning-message id set
 * (task #386): `AND m.id IN (?, ...)`. `undefined` means "no scope" (unchanged);
 * an empty list means "no messages" and short-circuits to `AND 0` without
 * loading a single row. Every id is a bound parameter.
 */
function messageScope(messageIds?: readonly string[]): { clause: string; values: string[] } {
	if (messageIds === undefined) return { clause: '', values: [] };
	if (messageIds.length === 0) return { clause: ' AND 0', values: [] };
	return {
		clause: ` AND m.id IN (${messageIds.map(() => '?').join(', ')})`,
		values: [...messageIds]
	};
}

/**
 * All messages of one session, in per-session order (`seq`). `role` is the
 * `type` column; all types are returned (the assembler filters).
 */
export function getMessages(sessionId: string): MessageRecord[] {
	const sql = `
		SELECT ${messageColumns('m')}
		FROM session_message m
		WHERE m.session_id = :sid
		ORDER BY m.seq`;
	const rows = getDb().query(sql).all({ ':sid': sessionId }) as Row[];
	return rows.map(mapMessageRow);
}

/**
 * Root-session turn projections, ordered by the trigger's `seq` (task #383).
 *
 * A `type='user'` message is the trigger (decision D-2, no `parentID`): its turn
 * is that message plus every `assistant` message with a greater `seq` up to
 * (excluding) the next `user` message. One SQL pass; no message payload crosses
 * into JS.
 */
export function getTurnSummaries(sessionId: string): TurnSummaryRecord[] {
	const userFilter = `trigger.type = '${MESSAGE_TYPE.user}'`;
	const sql = `
		SELECT trigger.id AS id,
			trigger.time_created AS started_at,
			(
				SELECT count(*)
				FROM session_message assistant
				WHERE assistant.session_id = trigger.session_id
					AND assistant.type = '${MESSAGE_TYPE.assistant}'
					AND assistant.seq > trigger.seq
					AND assistant.seq < COALESCE((
						SELECT min(next_trigger.seq)
						FROM session_message next_trigger
						WHERE next_trigger.session_id = trigger.session_id
							AND next_trigger.type = '${MESSAGE_TYPE.user}'
							AND next_trigger.seq > trigger.seq
					), 9223372036854775807)
			) AS assistant_count
		FROM session_message trigger
		WHERE trigger.session_id = :sid AND ${userFilter}
		ORDER BY trigger.seq`;
	const rows = getDb().query(sql).all({ ':sid': sessionId }) as Row[];
	return rows.map(mapTurnSummaryRow);
}

/**
 * Tool items of one session, read from
 * `json_each(session_message.data, '$.content')` (decision D-3). Optional
 * owning-message scope as above.
 */
export function getToolParts(sessionId: string, messageIds?: readonly string[]): ContentRecord[] {
	const typeFilter = jsonEquals('item.value', JSON_PATH.content.itemType, CONTENT_TYPE.tool);
	const scope = messageScope(messageIds);
	const sql = `
		SELECT ${contentColumns('item', 'm')}
		FROM session_message m, json_each(m.data, '${JSON_PATH.message.content}') AS item
		WHERE m.session_id = ? AND m.type = '${MESSAGE_TYPE.assistant}' AND ${typeFilter}${scope.clause}
		ORDER BY m.seq, item.key`;
	const rows = getDb().query(sql).all(sessionId, ...scope.values) as Row[];
	return rows.map(mapContentRow);
}

/**
 * Non-tool action items of one session (M-unified timeline): `text` and
 * `reasoning` (V2 dropped `patch`/`file`/`agent`, spec §3.4). Compaction is
 * fetched separately by {@link getCompactionParts} and merged by the assembler.
 * Optional owning-message scope as above.
 */
export function getActionParts(sessionId: string, messageIds?: readonly string[]): ContentRecord[] {
	const typeFilter = jsonIn('item.value', JSON_PATH.content.itemType, [
		CONTENT_TYPE.text,
		CONTENT_TYPE.reasoning
	]);
	const scope = messageScope(messageIds);
	const sql = `
		SELECT ${contentColumns('item', 'm')}
		FROM session_message m, json_each(m.data, '${JSON_PATH.message.content}') AS item
		WHERE m.session_id = ? AND m.type = '${MESSAGE_TYPE.assistant}' AND ${typeFilter}${scope.clause}
		ORDER BY m.seq, item.key`;
	const rows = getDb().query(sql).all(sessionId, ...scope.values) as Row[];
	return rows.map(mapContentRow);
}

/**
 * Compaction markers of one session (never a token subtraction). V2 moved
 * compaction from a `part` row to a whole `session_message` (spec §3.5/G-5), so
 * this reads the `type='compaction'` messages directly (no `json_each`).
 */
export function getCompactionParts(sessionId: string): ContentRecord[] {
	const sql = `
		SELECT m.id AS message_id,
			m.session_id AS session_id,
			0 AS item_index,
			m.type AS item_type,
			${jsonExtract('m.data', JSON_PATH.content.timeCreated)} AS item_time_created,
			${jsonExtract('m.data', JSON_PATH.content.timeRan)} AS item_time_ran,
			${jsonExtract('m.data', JSON_PATH.content.timeCompleted)} AS item_time_completed
		FROM session_message m
		WHERE m.session_id = :sid AND m.type = :type
		ORDER BY m.seq`;
	const rows = getDb()
		.query(sql)
		.all({ ':sid': sessionId, ':type': MESSAGE_TYPE.compaction }) as Row[];
	return rows.map(mapContentRow);
}
