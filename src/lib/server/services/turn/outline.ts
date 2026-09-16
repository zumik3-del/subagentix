/**
 * Lightweight turn outline (Phase 4 / task #387).
 *
 * The page streams rows/bars/edges first, so it needs only the nodes, edges and
 * turn metadata — not the heavy per-node detail. This module strips
 * `buildTurnModel`'s `steps`/`toolCalls`/`markers`/`actions`, which the client
 * then fetches per selected node as a {@link NodeDetail}.
 */
import type { GanttOutline } from '../../../model/types';
import { buildTurnModel } from './index';

/**
 * The lightweight Gantt payload for the turn triggered by `triggerMessageId`.
 * Returns `null` when the root session or the trigger message is unknown (the
 * same contract as {@link buildTurnModel}).
 */
export function buildTurnOutline(
	rootSessionId: string,
	triggerMessageId: string
): GanttOutline | null {
	const model = buildTurnModel(rootSessionId, triggerMessageId);
	if (!model) return null;
	return {
		turnId: model.turnId,
		triggerMessageId,
		rootSessionId: model.rootSessionId,
		agent: model.agent,
		t0: model.t0,
		t1: model.t1,
		nodes: model.nodes,
		edges: model.edges,
		trackerRefs: model.trackerRefs
	};
}
