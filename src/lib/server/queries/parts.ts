/**
 * Session-scoped part reads (ADR §6.2–6.3).
 *
 * Every query filters on `session_id = :sid` (or `aggregate_id = :sid` for the
 * `event` marker source) so SQLite uses `part_session_idx` /
 * `event_aggregate_type_seq_idx` instead of a full table scan.
 */
import { getDb } from '../db';
import {
	jsonEquals,
	jsonExtract,
	jsonIn,
	mapMessageRow,
	mapPartRow,
	mapRemovedMarkerRow,
	messageColumns,
	partColumns,
	EVENT_TYPE,
	JSON_PATH,
	PART_TYPE,
	type MessageRecord,
	type PartRecord,
	type RemovedMarkerRecord,
	type Row
} from '../schema';

/** All messages of one session, oldest first. */
export function getMessages(sessionId: string): MessageRecord[] {
	const sql = `
		SELECT ${messageColumns('message')}
		FROM message
		WHERE message.session_id = :sid
		ORDER BY message.time_created, message.id`;
	const rows = getDb().query(sql).all({ ':sid': sessionId }) as Row[];
	return rows.map(mapMessageRow);
}

/**
 * Step parts of one session: `step-start` (opens a step) and `step-finish`
 * (closes it, carries the canonical usage). Ordered so the assembler can pair
 * them deterministically.
 */
export function getStepParts(sessionId: string): PartRecord[] {
	const typeFilter = jsonIn('part.data', JSON_PATH.part.type, [
		PART_TYPE.stepStart,
		PART_TYPE.stepFinish
	]);
	const sql = `
		SELECT ${partColumns('part')}
		FROM part
		WHERE part.session_id = :sid AND ${typeFilter}
		ORDER BY part.time_created, part.id`;
	const rows = getDb().query(sql).all({ ':sid': sessionId }) as Row[];
	return rows.map(mapPartRow);
}

/** Tool / MCP parts of one session. */
export function getToolParts(sessionId: string): PartRecord[] {
	const typeFilter = jsonEquals('part.data', JSON_PATH.part.type, PART_TYPE.tool);
	const sql = `
		SELECT ${partColumns('part')}
		FROM part
		WHERE part.session_id = :sid AND ${typeFilter}
		ORDER BY part.time_created, part.id`;
	const rows = getDb().query(sql).all({ ':sid': sessionId }) as Row[];
	return rows.map(mapPartRow);
}

/**
 * Non-tool action parts of one session (M-unified timeline): `text`,
 * `reasoning`, `patch`, `file` and `agent` mentions. Compaction is fetched
 * separately by {@link getCompactionParts} and merged by the assembler.
 */
export function getActionParts(sessionId: string): PartRecord[] {
	const typeFilter = jsonIn('part.data', JSON_PATH.part.type, [
		PART_TYPE.text,
		PART_TYPE.reasoning,
		PART_TYPE.patch,
		PART_TYPE.file,
		PART_TYPE.agent
	]);
	const sql = `
		SELECT ${partColumns('part')}
		FROM part
		WHERE part.session_id = :sid AND ${typeFilter}
		ORDER BY part.time_created, part.id`;
	const rows = getDb().query(sql).all({ ':sid': sessionId }) as Row[];
	return rows.map(mapPartRow);
}

/** Compaction markers of one session (never a token subtraction). */
export function getCompactionParts(sessionId: string): PartRecord[] {
	const typeFilter = jsonEquals('part.data', JSON_PATH.part.type, PART_TYPE.compaction);
	const sql = `
		SELECT ${partColumns('part')}
		FROM part
		WHERE part.session_id = :sid AND ${typeFilter}
		ORDER BY part.time_created, part.id`;
	const rows = getDb().query(sql).all({ ':sid': sessionId }) as Row[];
	return rows.map(mapPartRow);
}

/**
 * `message.removed` events of one session (spec EC-3). The event payload keeps
 * only ids, never content, so these become markers only.
 */
export function getRemovedMarkers(sessionId: string): RemovedMarkerRecord[] {
	const sql = `
		SELECT event.aggregate_id AS session_id,
			${jsonExtract('event.data', JSON_PATH.event.messageId, 'message_id')}
		FROM event
		WHERE event.aggregate_id = :sid AND event.type = :type
		ORDER BY event.seq`;
	const rows = getDb()
		.query(sql)
		.all({ ':sid': sessionId, ':type': EVENT_TYPE.messageRemoved }) as Row[];
	return rows.map(mapRemovedMarkerRow);
}
