/**
 * Tool-call assembly: map raw `tool` parts to {@link ToolCall} DTOs and resolve
 * each call's permission prompt from a prebuilt index.
 */
import type { PermissionInfo, ToolCall } from '../../../model/types';
import { permissionKey } from '../../permission-store';
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

/**
 * Resolve one call's prompt from the prebuilt index. `callId === null` has no
 * join key (preserved: such calls never match).
 */
function resolvePermission(
	index: Map<string, PermissionInfo>,
	sessionId: string,
	callId: string | null
): PermissionInfo | null {
	if (callId === null) return null;
	return index.get(permissionKey(sessionId, callId)) ?? null;
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
 * when given, and join each call to the permission index in one pass.
 */
export function buildToolCalls(
	sd: SessionData,
	restrict: Set<string> | null,
	index: Map<string, PermissionInfo>,
	now: number
): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const part of sd.toolParts) {
		if (restrict && !restrict.has(part.messageId)) continue;
		const call = mapToolCall(part, sd.session.id, now);
		call.permission = resolvePermission(index, call.nodeId, call.callId);
		calls.push(call);
	}
	return calls;
}
