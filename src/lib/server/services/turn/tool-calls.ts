/**
 * Tool-call assembly: map raw `tool` content items to {@link ToolCall} DTOs.
 */
import { isMcpTool } from '$lib/model/tool-kind';
import type { ToolCall } from '../../../model/types';
import { toolOutputText, type ContentRecord } from '../../schema';
import { clampEnd, itemsIn, type SessionData } from './shared';
import { extractTrackerRefs } from './tracker-refs';

function mapToolCall(item: ContentRecord, nodeId: string, now: number): ToolCall {
	const startedAt = item.timeRan ?? item.timeCreated;
	const { endedAt, flags } = clampEnd(startedAt ?? now, item.timeCompleted, now);
	const name = item.name ?? 'unknown';
	const output = toolOutputText(item.content);
	return {
		id: item.id,
		nodeId,
		stepId: null,
		callId: item.callId,
		name,
		status: item.status ?? 'unknown',
		error: item.errorMessage ?? item.errorType,
		startedAt,
		endedAt,
		flags,
		input: item.input,
		output,
		isMcp: isMcpTool(name),
		isDelegation: name === 'subagent',
		trackerRefs: extractTrackerRefs(name, {
			input: item.input,
			output,
			prompt: item.prompt,
			description: item.description
		})
	};
}

/**
 * Map a session's tool items to calls, restricted to `restrict` message ids
 * when given.
 */
export function buildToolCalls(
	sd: SessionData,
	restrict: Set<string> | null,
	now: number
): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const item of itemsIn(sd.toolItems, restrict)) {
		calls.push(mapToolCall(item, sd.session.id, now));
	}
	return calls;
}
