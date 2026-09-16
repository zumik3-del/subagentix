/**
 * Session-detail service (ADR §7.3): composes the query layer into the
 * `/api/sessions/[id]` payload and the `/sessions/[id]` page data.
 *
 * Domain assembly only — no SQL. It reuses the turn assembler's edge mapper so
 * the session header and the Gantt agree on the delegation shape.
 */
import { usageFromCounts } from '../../model/token';
import type { ChildSession, SessionDetail, TurnSummary } from '../../model/types';
import { getTurnSummaries } from '../queries/parts';
import { loadSessionGraph } from '../queries/session-graph';
import { sessionExists, toSessionSummary } from '../queries/sessions';
import type { DelegationRecord, SessionRecord } from '../schema';
import { buildEdge } from './turn';

/**
 * Root-session turns, ordered by trigger `time_created` (already ordered by the
 * query). `turnId` is the root user message id; `index` is 1-based;
 * `assistantCount` counts the assistant messages parented to the trigger.
 *
 * Reads only the compact per-turn SQL projection ({@link getTurnSummaries}),
 * never the session's full message rows. Returns `null` for an unknown session
 * so `/api/sessions/[id]/turns` can answer 404.
 */
export function listTurns(rootSessionId: string): TurnSummary[] | null {
	if (!sessionExists(rootSessionId)) return null;
	return getTurnSummaries(rootSessionId).map((turn, index) => ({
		turnId: turn.id,
		index: index + 1,
		startedAt: turn.startedAt,
		assistantCount: turn.assistantCount
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
	const { subtree, edges } = loadSessionGraph(rootSessionId);
	const root = subtree.find((session) => session.id === rootSessionId);
	if (!root) return null;

	const now = Date.now();
	const childCount = subtree.filter((session) => session.parentId === rootSessionId).length;
	const children = subtree
		.filter((session) => session.id !== rootSessionId)
		.map((session) => toChildSession(session, session.depth));

	// The subtree edges arrive grouped by session (query order); regroup them in
	// subtree order so the DTO keeps the previous child-before-parent ordering.
	const edgesBySession = new Map<string, DelegationRecord[]>();
	for (const edge of edges) {
		const list = edgesBySession.get(edge.sessionId);
		if (list) list.push(edge);
		else edgesBySession.set(edge.sessionId, [edge]);
	}
	const orderedEdges: DelegationRecord[] = [];
	for (const session of subtree) orderedEdges.push(...(edgesBySession.get(session.id) ?? []));

	return {
		session: toSessionSummary({ ...root, childCount }),
		children,
		edges: orderedEdges.map((edge) => buildEdge(edge, now)),
		turns: listTurns(rootSessionId) ?? []
	};
}
