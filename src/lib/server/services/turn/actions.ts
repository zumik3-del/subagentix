/**
 * Action assembly: map non-tool parts (text, reasoning, patch, file, agent,
 * compaction) to timeline {@link Action} DTOs.
 */
import type { Action, ActionKind } from '../../../model/types';
import { PART_TYPE, type PartRecord } from '../../schema';
import { partsIn, type SessionData } from './shared';

/** Parse a `patch.files` JSON array into a comma-joined summary (tolerant). */
function patchFilesSummary(files: string | null): string {
	if (!files) return '';
	try {
		const parsed: unknown = JSON.parse(files);
		if (!Array.isArray(parsed)) return files;
		return parsed.map((value) => String(value)).join(', ');
	} catch {
		return files;
	}
}

/** Map one non-tool part to a timeline {@link Action}. */
function mapAction(
	part: PartRecord,
	kind: ActionKind,
	nodeId: string,
	role: string | null
): Action {
	const at = part.partStart ?? part.createdAt;
	switch (kind) {
		case 'text':
		case 'reasoning':
			return {
				id: part.id,
				nodeId,
				kind,
				at,
				endedAt: part.partEnd,
				label: kind,
				summary: part.text ?? '',
				role
			};
		case 'patch':
			return {
				id: part.id,
				nodeId,
				kind,
				at,
				endedAt: null,
				label: 'patch',
				summary: patchFilesSummary(part.files),
				role
			};
		case 'file':
			return {
				id: part.id,
				nodeId,
				kind,
				at,
				endedAt: null,
				label: part.filename ?? 'file',
				summary: part.mime ?? '',
				role
			};
		case 'agent':
			return {
				id: part.id,
				nodeId,
				kind,
				at,
				endedAt: null,
				label: part.agentName ?? 'agent',
				summary: '',
				role
			};
		case 'compaction':
			return {
				id: part.id,
				nodeId,
				kind,
				at,
				endedAt: null,
				label: 'compaction',
				summary: '',
				role: null
			};
	}
}

/** Map a session's non-tool parts (and its compaction mirrors) to actions. */
export function buildActions(sd: SessionData, restrict: Set<string> | null): Action[] {
	const actions: Action[] = [];
	const roleByMessage = new Map(sd.messages.map((message) => [message.id, message.role]));
	for (const part of partsIn(sd.actionParts, restrict)) {
		const kind = part.type as ActionKind;
		if (kind === 'text' || kind === 'reasoning' || kind === 'patch' || kind === 'file' || kind === 'agent') {
			actions.push(mapAction(part, kind, sd.session.id, roleByMessage.get(part.messageId) ?? null));
		}
	}
	// Compaction mirrors the marker list: already time-filtered for the root,
	// never message-restricted.
	for (const part of sd.compaction) {
		actions.push(mapAction(part, 'compaction', sd.session.id, null));
	}
	return actions;
}
