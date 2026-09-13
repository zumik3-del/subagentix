/**
 * Session-detail service (ADR §7.3): composes the query layer into the
 * `/api/sessions/[id]` payload and the `/sessions/[id]` page data.
 *
 * Domain assembly only — no SQL. It reuses the turn assembler's edge mapper so
 * the session header and the Gantt agree on the delegation shape.
 */
import { usageFromCounts } from '../../model/token';
import type { ChildSession, SessionDetail, TurnSummary } from '../../model/types';
import { getMessages } from '../queries/parts';
import {
	getDelegationEdges,
	getSessionSubtree,
	toSessionSummary
} from '../queries/sessions';
import type { DelegationRecord, SessionRecord } from '../schema';
import { buildEdge } from './turn';

/**
 * Root-session turns, ordered by trigger `time_created` (already ordered by the
 * query). `turnId` is the root user message id; `index` is 1-based;
 * `assistantCount` counts the assistant messages parented to the trigger.
 */
export function listTurns(rootSessionId: string): TurnSummary[] {
	const messages = getMessages(rootSessionId);
	const assistantCounts = new Map<string, number>();
	for (const message of messages) {
		if (message.role !== 'assistant' || message.parentId === null) continue;
		assistantCounts.set(message.parentId, (assistantCounts.get(message.parentId) ?? 0) + 1);
	}
	return messages
		.filter((message) => message.role === 'user')
		.map((message, index) => ({
			turnId: message.id,
			index: index + 1,
			startedAt: message.createdAt,
			assistantCount: assistantCounts.get(message.id) ?? 0
		}));
}

function toChildSession(record: SessionRecord, depth: number): ChildSession {
	return {
		id: record.id,
		parentId: record.parentId,
		title: record.title,
		agent: record.agent ?? 'unknown',
		directory: record.directory,
		depth,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		archivedAt: record.archivedAt,
		usage: usageFromCounts(record.usage, record.cost)
	};
}

/**
 * Session header, its subtree children, every delegation edge in the subtree
 * and the root's turn list. Returns `null` for an unknown session id.
 */
export function getSessionDetail(rootSessionId: string): SessionDetail | null {
	const subtree = getSessionSubtree(rootSessionId);
	const root = subtree.find((session) => session.id === rootSessionId);
	if (!root) return null;

	const now = Date.now();
	const childCount = subtree.filter((session) => session.parentId === rootSessionId).length;
	const children = subtree
		.filter((session) => session.id !== rootSessionId)
		.map((session) => toChildSession(session, session.depth));

	// Gather edges for the root and every descendant, deduplicated by part id.
	const edgeRecords = new Map<string, DelegationRecord>();
	for (const session of subtree) {
		for (const edge of getDelegationEdges(session.id)) edgeRecords.set(edge.id, edge);
	}

	return {
		session: toSessionSummary({ ...root, childCount }),
		children,
		edges: [...edgeRecords.values()].map((edge) => buildEdge(edge, now)),
		turns: listTurns(rootSessionId)
	};
}
