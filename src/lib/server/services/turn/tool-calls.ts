/**
 * Tool-call assembly: map raw `tool` content items to {@link ToolCall} DTOs.
 */
import { CODE_MODE_TOOL, DELEGATION_TOOL, isMcpTool } from '$lib/model/tool-kind';
import type { ToolCall } from '../../../model/types';
import { toolOutputText, type ContentRecord } from '../../schema';
import { clampEnd, itemsIn, type SessionData } from './shared';
import { UNKNOWN_LABEL } from '../../queries/dashboard-shared';
import { extractTrackerRefs } from './tracker-refs';

function mapToolCall(item: ContentRecord, nodeId: string, now: number): ToolCall {
	const startedAt = item.timeRan ?? item.timeCreated;
	const { endedAt, flags } = clampEnd(startedAt ?? now, item.timeCompleted, now);
	const name = item.name ?? UNKNOWN_LABEL;
	const output = toolOutputText(item.content);
	return {
		id: item.id,
		nodeId,
		stepId: null,
		callId: item.callId,
		name,
		status: item.status ?? UNKNOWN_LABEL,
		error: item.errorMessage ?? item.errorType,
		startedAt,
		endedAt,
		flags,
		input: item.input,
		output,
		isMcp: isMcpTool(name),
		isDelegation: name === DELEGATION_TOOL,
		trackerRefs: extractTrackerRefs(name, {
			input: item.input,
			output,
			prompt: item.prompt,
			description: item.description
		})
	};
}

/**
 * Map one nested Code Mode tool call (ADR D-2) to a {@link ToolCall} DTO.
 * The nested call inherits timing/flags from the parent `execute` item and
 * carries `parentCallId` so the UI can render nesting.
 */
function mapNestedToolCall(
	item: ContentRecord,
	nested: ContentRecord['toolCalls'][number],
	index: number,
	nodeId: string,
	now: number
): ToolCall {
	const startedAt = item.timeRan ?? item.timeCreated;
	const { endedAt, flags } = clampEnd(startedAt ?? now, item.timeCompleted, now);
	return {
		id: `${item.id}#n${index}`,
		nodeId,
		stepId: null,
		callId: null,
		name: nested.tool,
		status: nested.status,
		error: null,
		startedAt,
		endedAt,
		flags,
		input: nested.input,
		output: null,
		isMcp: isMcpTool(nested.tool),
		isDelegation: false,
		trackerRefs: [],
		parentCallId: item.id
	};
}

/**
 * Map a session's tool items to calls, restricted to `restrict` message ids
 * when given. For `execute` items with nested Code Mode tool calls, one extra
 * {@link ToolCall} is emitted per nested entry, right after the parent.
 */
export function buildToolCalls(
	sd: SessionData,
	restrict: Set<string> | null,
	now: number
): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const item of itemsIn(sd.toolItems, restrict)) {
		calls.push(mapToolCall(item, sd.session.id, now));
		if (item.name === CODE_MODE_TOOL && item.toolCalls.length > 0) {
			for (let i = 0; i < item.toolCalls.length; i++) {
				calls.push(mapNestedToolCall(item, item.toolCalls[i], i, sd.session.id, now));
			}
		}
	}
	return calls;
}
