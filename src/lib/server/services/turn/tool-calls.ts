/**
 * Tool-call assembly: map raw `tool` parts to {@link ToolCall} DTOs.
 */
import type { ToolCall } from '../../../model/types';
import type { PartRecord } from '../../schema';
import { clampEnd, type SessionData } from './shared';
import { extractTrackerRefs } from './tracker-refs';

/** Tools that ship with opencode; everything with `_` and not here is MCP. */
const BUILTIN_TOOLS = new Set([
	'bash',
	'read',
	'edit',
	'grep',
	'glob',
	'write',
	'webfetch',
	'todowrite',
	'task',
	'question',
	'skill',
	'invalid'
]);

function isMcpTool(name: string): boolean {
	return name.includes('_') && !BUILTIN_TOOLS.has(name);
}

function mapToolCall(part: PartRecord, nodeId: string, now: number): ToolCall {
	const startedAt = part.stateStart;
	const { endedAt, flags } = clampEnd(startedAt ?? now, part.stateEnd, now);
	const name = part.tool ?? 'unknown';
	return {
		id: part.id,
		nodeId,
		stepId: null,
		callId: part.callId,
		name,
		status: part.status ?? 'unknown',
		error: part.error,
		startedAt,
		endedAt,
		flags,
		input: part.input,
		output: part.output,
		isMcp: isMcpTool(name),
		isDelegation: name === 'task',
		trackerRefs: extractTrackerRefs(name, {
			input: part.input,
			output: part.output,
			prompt: part.prompt,
			description: part.description
		})
	};
}

/**
 * Map a session's tool parts to calls, restricted to `restrict` message ids
 * when given.
 */
export function buildToolCalls(
	sd: SessionData,
	restrict: Set<string> | null,
	now: number
): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const part of sd.toolParts) {
		if (restrict && !restrict.has(part.messageId)) continue;
		calls.push(mapToolCall(part, sd.session.id, now));
	}
	return calls;
}
