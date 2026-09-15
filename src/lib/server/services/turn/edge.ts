/**
 * Delegation-edge assembly: map one raw delegation record to the shared
 * {@link Edge} DTO.
 */
import type { Edge, EdgeFlag } from '../../../model/types';
import type { DelegationRecord } from '../../schema';
import { clampEnd } from './shared';
import { extractTrackerRefs } from './tracker-refs';

/**
 * Map one delegation record to the shared `Edge` DTO. Exported so the session
 * detail service and the Gantt agree on the edge shape.
 */
export function buildEdge(record: DelegationRecord, now: number): Edge {
	const startedAt = record.startedAt ?? record.createdAt;
	const running = record.status === 'running' || record.endedAt === null;
	const { endedAt, flags: clampFlags } = clampEnd(startedAt, record.endedAt, now);
	const flags: EdgeFlag[] = [...clampFlags];
	if (record.childSessionId === null) flags.push('noChild');
	return {
		id: record.id,
		parentNodeId: record.parentSessionId ?? record.sessionId,
		childNodeId: record.childSessionId,
		subagentType: record.subagentType,
		status: record.status,
		error: record.error,
		startedAt,
		endedAt: running ? null : endedAt,
		running,
		flags,
		resultBytes: record.resultBytes,
		description: record.description,
		trackerRefs: extractTrackerRefs('task', {
			input: null,
			output: null,
			prompt: record.prompt,
			description: record.description
		})
	};
}
