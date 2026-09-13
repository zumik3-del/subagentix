/**
 * Node drill-down service (M3c, ADR §7.2 item 3): composes the turn assembler
 * into a {@link NodeDetail} for one node of one turn.
 *
 * This is the API counterpart of the client's pure `selectNodeDetail`; both
 * return the same shape, so the route and the already-loaded Gantt agree.
 * Domain assembly only — no SQL (queries stay in `queries/**`).
 */
import type { GanttModel, NodeDetail } from '../../model/types';
import { getMessages } from '../queries/parts';
import { getSessionSubtree } from '../queries/sessions';
import { buildTurnModel } from './turn';

/**
 * Find a turn of `rootSessionId` that owns `nodeId` by scanning the root's
 * `role='user'` triggers in order (fallback when no `turnId` is supplied). The
 * root node belongs to every turn, so the first turn matches it.
 */
function findTurnWithNode(rootSessionId: string, nodeId: string): GanttModel | null {
	const triggers = getMessages(rootSessionId).filter((message) => message.role === 'user');
	for (const trigger of triggers) {
		const model = buildTurnModel(rootSessionId, trigger.id);
		if (model?.nodes.some((node) => node.sessionId === nodeId)) return model;
	}
	return null;
}

/**
 * The requested node plus only its steps, tool calls and markers. Returns
 * `null` when the root session, the turn (when given) or the node is unknown.
 *
 * With no `turnId` it locates a turn in the root session that contains the node
 * (root `role='user'` fallback scan); the node must belong to the root's subtree.
 */
export function buildNodeDetail(
	rootSessionId: string,
	nodeId: string,
	turnId?: string
): NodeDetail | null {
	let model: GanttModel | null;
	if (turnId !== undefined) {
		model = buildTurnModel(rootSessionId, turnId);
	} else {
		// Cheap subtree guard: reject a node that is not under the root before
		// paying for a turn rebuild per trigger.
		const inSubtree = getSessionSubtree(rootSessionId).some((session) => session.id === nodeId);
		model = inSubtree ? findTurnWithNode(rootSessionId, nodeId) : null;
	}
	if (!model) return null;

	const node = model.nodes.find((candidate) => candidate.sessionId === nodeId);
	if (!node) return null;

	return {
		node,
		steps: model.steps.filter((step) => step.nodeId === nodeId),
		toolCalls: model.toolCalls.filter((call) => call.nodeId === nodeId),
		markers: model.markers.filter((marker) => marker.nodeId === nodeId),
		actions: (model.actions ?? []).filter((action) => action.nodeId === nodeId)
	};
}
