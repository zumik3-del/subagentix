/**
 * Turn scope: which sessions belong to a turn, which delegation edges it
 * observes, and the overlap/orphan flags derived after the raw spans are known.
 */
import type { Node } from '../../../model/types';
import { getDelegationEdges } from '../../queries/sessions';
import type { SessionSubtreeRecord } from '../../queries/sessions';
import type { DelegationRecord, MessageRecord } from '../../schema';
import { edgeSortTime, turnIndexOf, type SessionData } from './shared';

/**
 * Node -> turn index for the depth-1 sessions: the earliest spawn edge assigns
 * the node (spec R3).
 */
export function computeTurnOfSession(
	subtree: SessionSubtreeRecord[],
	rootEdges: DelegationRecord[],
	triggers: MessageRecord[]
): Map<string, number> {
	const turnOfSession = new Map<string, number>();
	for (const session of subtree) {
		if (session.depth !== 1) continue;
		const edges = rootEdges.filter((edge) => edge.childSessionId === session.id);
		if (edges.length === 0) continue;
		const earliest = edges.reduce((a, b) => (edgeSortTime(a) <= edgeSortTime(b) ? a : b));
		turnOfSession.set(session.id, turnIndexOf(edgeSortTime(earliest), triggers));
	}
	return turnOfSession;
}

/**
 * Sessions owned by `triggerIndex`: the root plus every session whose top-level
 * (depth-1) ancestor maps to this turn.
 */
export function selectTurnSessions(
	subtree: SessionSubtreeRecord[],
	turnOfSession: Map<string, number>,
	triggerIndex: number
): SessionSubtreeRecord[] {
	const parentById = new Map(subtree.map((session) => [session.id, session.parentId]));
	const depthById = new Map(subtree.map((session) => [session.id, session.depth]));
	const topLevelAncestor = (sessionId: string): string => {
		let current = sessionId;
		while ((depthById.get(current) ?? 0) > 1) {
			const parent = parentById.get(current);
			if (!parent) break;
			current = parent;
		}
		return current;
	};

	return subtree.filter(
		(session) =>
			session.depth === 0 || turnOfSession.get(topLevelAncestor(session.id)) === triggerIndex
	);
}

/**
 * Edge records observed by the turn: this turn's root edges plus every edge of a
 * subagent node in the turn. Root edges with a spawned child are counted in
 * `onSubEdge`-free order; sub edges are passed to `onSubEdge` as they are
 * collected so callers can roll up spawn counts without re-querying.
 */
export function selectEdgeRecords(
	rootEdges: DelegationRecord[],
	sessionDataList: SessionData[],
	rootSessionId: string,
	triggers: MessageRecord[],
	triggerIndex: number,
	turnOfSession: Map<string, number>,
	onSubEdge?: (edge: DelegationRecord) => void
): Map<string, DelegationRecord> {
	const edgeRecords = new Map<string, DelegationRecord>();
	for (const edge of rootEdges) {
		const inWindow = turnIndexOf(edgeSortTime(edge), triggers) === triggerIndex;
		const childInTurn =
			edge.childSessionId !== null && turnOfSession.get(edge.childSessionId) === triggerIndex;
		if (inWindow || childInTurn) edgeRecords.set(edge.id, edge);
	}
	for (const data of sessionDataList) {
		if (data.session.id === rootSessionId) continue;
		for (const edge of getDelegationEdges(data.session.id)) {
			edgeRecords.set(edge.id, edge);
			onSubEdge?.(edge);
		}
	}
	return edgeRecords;
}

/**
 * Post-assembly scope flags: `overlapsNextTurn` for nodes whose raw span crosses
 * the next trigger, and `orphanEdge` for edges that precede the first trigger.
 */
export function applyScopeFlags(
	nodes: Node[],
	edgeRecords: Map<string, DelegationRecord>,
	rawEndBySession: Map<string, number | null>,
	nextTrigger: MessageRecord | null,
	triggers: MessageRecord[]
): void {
	if (nextTrigger) {
		for (const node of nodes) {
			const rawEnd = rawEndBySession.get(node.sessionId);
			if (rawEnd !== null && rawEnd !== undefined && rawEnd > nextTrigger.startedAt) {
				node.flags.push('overlapsNextTurn');
			}
		}
	}
	for (const edge of edgeRecords.values()) {
		if (edgeSortTime(edge) < triggers[0].startedAt) {
			const parentId = edge.parentSessionId ?? edge.sessionId;
			const parent = nodes.find((node) => node.sessionId === parentId);
			if (parent && !parent.flags.includes('orphanEdge')) parent.flags.push('orphanEdge');
		}
	}
}
