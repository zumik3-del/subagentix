/**
 * Node drill-down service (M3c, ADR §7.2 item 3): composes the turn assembler
 * into a {@link NodeDetail} for one node of one turn.
 *
 * Phase 4 / task #387: assembles only the requested node (through the same
 * `buildSessionNode` used by `buildTurnModel`) instead of rebuilding the whole
 * turn model, so a per-node read stays proportional to that node. It reuses the
 * cached session graph (subtree + subtree edges, task #386), the turn-scoped
 * part reads and the shared turn-scope helpers — no separate SQL path.
 *
 * This is the API counterpart of the client's pure `selectNodeDetail`; both
 * return the same shape, so the route and the already-loaded Gantt agree.
 */
import { nodeTrackerRefs } from '../../model/tracker';
import type { NodeDetail } from '../../model/types';
import {
	getActionParts,
	getCompactionParts,
	getMessages,
	getRemovedMarkers,
	getStepParts,
	getToolParts
} from '../queries/parts';
import { loadSessionGraph } from '../queries/session-graph';
import type { SessionSubtreeRecord } from '../queries/sessions';
import { buildEdge } from './turn';
import { buildSessionNode } from './turn/node';
import { applyScopeFlags, computeTurnOfSession, selectEdgeRecords, selectTurnSessions } from './turn/scope';
import type { SessionData } from './turn/shared';

/**
 * The turn index that owns `nodeId`, or `null` when no turn does. Mirrors the
 * scope `buildTurnModel` computes: the root belongs to the first turn, a
 * depth-1 node to its earliest spawn edge's turn, a deeper node to its depth-1
 * ancestor's turn.
 */
function turnIndexForNode(
	rootSessionId: string,
	nodeId: string,
	subtree: SessionSubtreeRecord[],
	turnOfSession: Map<string, number>
): number | null {
	if (nodeId === rootSessionId) return 0;
	const depthById = new Map(subtree.map((session) => [session.id, session.depth]));
	const parentById = new Map(subtree.map((session) => [session.id, session.parentId]));
	let current = nodeId;
	while ((depthById.get(current) ?? 0) > 1) {
		const parent = parentById.get(current);
		if (!parent) return null;
		current = parent;
	}
	return turnOfSession.get(current) ?? null;
}

/**
 * The requested node plus only its steps, tool calls, markers and actions.
 * Returns `null` when the root session, the turn (when given) or the node is
 * unknown, or when the node does not belong to the turn's scope.
 *
 * With no `turnId` the owning turn is resolved from the cached session graph
 * (root user-trigger fallback); the node must belong to the root's subtree.
 */
export function buildNodeDetail(
	rootSessionId: string,
	nodeId: string,
	turnId?: string
): NodeDetail | null {
	const now = Date.now();
	const { subtree, edges: subtreeEdges } = loadSessionGraph(rootSessionId);
	const rootSession = subtree.find((session) => session.id === rootSessionId);
	const nodeSession = subtree.find((session) => session.id === nodeId);
	if (!rootSession || !nodeSession) return null;

	const rootMessages = getMessages(rootSessionId);
	const triggers = rootMessages.filter((message) => message.role === 'user');
	if (triggers.length === 0) return null;

	const rootEdges = subtreeEdges.filter((edge) => edge.sessionId === rootSessionId);
	const turnOfSession = computeTurnOfSession(subtree, rootEdges, triggers);

	let triggerIndex: number | null;
	if (turnId !== undefined) {
		const index = triggers.findIndex((message) => message.id === turnId);
		triggerIndex = index === -1 ? null : index;
	} else {
		triggerIndex = turnIndexForNode(rootSessionId, nodeId, subtree, turnOfSession);
	}
	if (triggerIndex === null) return null;

	// The node must be in the resolved turn's scope (a subtree session with no
	// spawn edge belongs to no turn).
	if (!selectTurnSessions(subtree, turnOfSession, triggerIndex).some((s) => s.id === nodeId)) {
		return null;
	}

	const trigger = triggers[triggerIndex];
	const nextTrigger = triggers[triggerIndex + 1] ?? null;
	const isRoot = nodeId === rootSessionId;
	// The root's part reads are scoped to this turn's messages in SQL, so another
	// turn's parts never reach JS (task #386); subagent turns own the full session.
	const turnMessageIds = rootMessages
		.filter((message) => message.role === 'assistant' && message.parentId === trigger.id)
		.map((message) => message.id);
	const scope = isRoot ? turnMessageIds : undefined;

	const sessionData: SessionData = {
		session: nodeSession,
		messages: isRoot ? rootMessages : getMessages(nodeSession.id),
		stepParts: getStepParts(nodeSession.id, scope),
		toolParts: getToolParts(nodeSession.id, scope),
		actionParts: getActionParts(nodeSession.id, scope),
		compaction: getCompactionParts(nodeSession.id),
		removed: getRemovedMarkers(nodeSession.id)
	};

	// Node -> spawn counts / subagent fallback. `buildTurnModel` counts the root
	// edges first, then the sub-session edges; keep that order for a stable
	// subagent-type fallback.
	const spawnEdges = [
		...rootEdges.filter((edge) => edge.childSessionId === nodeId),
		...subtreeEdges.filter(
			(edge) => edge.sessionId !== rootSessionId && edge.childSessionId === nodeId
		)
	];

	const built = buildSessionNode(
		sessionData,
		isRoot ? new Set(turnMessageIds) : null,
		isRoot ? trigger.startedAt : null,
		spawnEdges.length,
		spawnEdges.find((edge) => edge.subagentType)?.subagentType ?? null,
		now
	);

	// The node's own edges, computed through the same scope selector as the full
	// model: root edges within the turn window plus every edge of this session.
	const edgeRecords = selectEdgeRecords(
		rootEdges,
		subtreeEdges,
		[sessionData],
		rootSessionId,
		triggers,
		triggerIndex,
		turnOfSession
	);
	applyScopeFlags([built.node], edgeRecords, new Map([[nodeId, built.rawEnd]]), nextTrigger, triggers);

	built.node.trackerRefs = nodeTrackerRefs(
		built.node,
		built.toolCalls,
		[...edgeRecords.values()].map((record) => buildEdge(record, now))
	);

	return {
		node: built.node,
		steps: built.steps,
		toolCalls: built.toolCalls,
		markers: built.markers,
		actions: built.actions
	};
}
