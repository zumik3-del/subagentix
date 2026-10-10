/**
 * Action assembly: map non-tool content items (`text`, `reasoning`) and
 * compaction messages to timeline {@link Action} DTOs, and synthesise one
 * `text` action per `user` message (V2 stores the prompt in `data.text`, not as
 * a content item — spec §3.7/G-7).
 */
import type { Action, ActionKind } from '../../../model/types';
import { CONTENT_TYPE, MESSAGE_TYPE, type ContentRecord, type MessageRecord } from '../../schema';
import { itemsIn, type SessionData } from './shared';

/** Map one `text`/`reasoning` content item to a timeline {@link Action}. */
function mapContentItemAction(
	item: ContentRecord,
	kind: ActionKind,
	message: MessageRecord | undefined
): Action {
	return {
		id: item.id,
		nodeId: item.sessionId,
		kind,
		// `text` items carry no `time` at all; fall back to the owning message
		// (spec §3.9/G-9) and flag the approximation for the timeline.
		at: item.timeCreated ?? message?.startedAt ?? 0,
		endedAt: item.timeCompleted,
		label: kind,
		summary: item.text ?? '',
		role: message?.role ?? null,
		noTime: item.timeCreated === null
	};
}

/** Map a session's content items, user prompts and compaction mirrors to actions. */
export function buildActions(
	sd: SessionData,
	restrict: Set<string> | null,
	turnWindow?: { start: number; end: number }
): Action[] {
	const actions: Action[] = [];
	const messageById = new Map(sd.messages.map((message) => [message.id, message]));
	for (const item of itemsIn(sd.actionItems, restrict)) {
		const kind = item.type as ActionKind;
		if (kind !== CONTENT_TYPE.text && kind !== CONTENT_TYPE.reasoning) continue;
		actions.push(mapContentItemAction(item, kind, messageById.get(item.messageId)));
	}
	// A `user` message has no `content[]`; synthesise its prompt as a `text`
	// action so it stays visible in the timeline (spec §3.7/G-7 blocker).
	const messages = restrict ? sd.messages.filter((message) => restrict.has(message.id)) : sd.messages;
	for (const message of messages) {
		if (message.role !== MESSAGE_TYPE.user) continue;
		actions.push({
			id: message.id,
			nodeId: sd.session.id,
			kind: 'text',
			at: message.startedAt,
			endedAt: null,
			label: 'prompt',
			summary: message.text ?? '',
			role: MESSAGE_TYPE.user
		});
	}
	// Compaction mirrors the marker list: already time-filtered for the root,
	// never message-restricted. When `turnWindow` is given (root session), keep
	// only compactions that landed inside this turn's span; otherwise emit all
	// (subagent sessions are turn-scoped by construction).
	for (const item of sd.compactions) {
		const at = item.timeCreated ?? item.timeRan ?? item.timeCompleted ?? sd.session.createdAt ?? 0;
		if (turnWindow && (at < turnWindow.start || at >= turnWindow.end)) continue;
		actions.push({
			id: item.id,
			nodeId: sd.session.id,
			kind: 'compaction',
			at,
			endedAt: null,
			label: 'compaction',
			summary: '',
			role: null
		});
	}
	return actions;
}
