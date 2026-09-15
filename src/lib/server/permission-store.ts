/**
 * Permission-request store (feature: surface user permission prompts).
 *
 * opencode does not persist runtime permission asks/replies in its SQLite
 * database — they exist only on its event bus. This module persists the
 * `permission.asked` / `permission.replied` events that the collector sees to
 * an append-only JSONL file, and indexes them so the turn assembler can join a
 * prompt back to the tool call that triggered it (session id + call id).
 *
 * History therefore starts when the collector first runs; earlier prompts were
 * never recorded anywhere and cannot be recovered.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PermissionInfo } from '../model/types';
import { settingsFilePath } from './settings';

export type PermissionReply = 'once' | 'always' | 'reject';

export interface PermissionAskedInput {
	requestId: string;
	sessionId: string;
	callId: string | null;
	permission: string;
	patterns: string[];
	at: number;
}

export interface PermissionRepliedInput {
	requestId: string;
	sessionId: string;
	reply: PermissionReply;
	at: number;
}

interface AskedRecord extends PermissionAskedInput {
	type: 'asked';
}

interface RepliedRecord extends PermissionRepliedInput {
	type: 'replied';
}

type PermissionRecord = AskedRecord | RepliedRecord;

interface StoredRequest {
	sessionId: string;
	callId: string | null;
	permission: string;
	patterns: string[];
	askedAt: number;
	reply: PermissionReply | null;
	repliedAt: number | null;
}

/** Explicit `PERMISSIONS_FILE` -> state dir next to `settings.json`. */
export function permissionsFilePath(): string {
	if (process.env.PERMISSIONS_FILE) return process.env.PERMISSIONS_FILE;
	return join(dirname(settingsFilePath()), 'permissions.jsonl');
}

let loaded = false;
const requests = new Map<string, StoredRequest>();

function appendRecord(record: PermissionRecord): void {
	const file = permissionsFilePath();
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	} catch (error) {
		console.warn('[permissions] failed to persist record:', error);
	}
}

function apply(record: PermissionRecord, persist: boolean): void {
	if (record.type === 'asked') {
		const previous = requests.get(record.requestId);
		requests.set(record.requestId, {
			sessionId: record.sessionId,
			callId: record.callId,
			permission: record.permission,
			patterns: record.patterns,
			askedAt: record.at,
			reply: previous?.reply ?? null,
			repliedAt: previous?.repliedAt ?? null
		});
	} else {
		const previous = requests.get(record.requestId);
		if (previous) {
			previous.reply = record.reply;
			previous.repliedAt = record.at;
		} else {
			// Reply seen without its ask (collector started mid-flight).
			requests.set(record.requestId, {
				sessionId: record.sessionId,
				callId: null,
				permission: '',
				patterns: [],
				askedAt: record.at,
				reply: record.reply,
				repliedAt: record.at
			});
		}
	}
	if (persist) appendRecord(record);
}

/** Replay the JSONL file once; corrupt lines are skipped, never fatal. */
function ensureLoaded(): void {
	if (loaded) return;
	loaded = true;
	const file = permissionsFilePath();
	if (!existsSync(file)) return;
	try {
		for (const line of readFileSync(file, 'utf8').split('\n')) {
			if (line.trim() === '') continue;
			try {
				apply(JSON.parse(line) as PermissionRecord, false);
			} catch {
				// Ignore a single malformed line.
			}
		}
	} catch (error) {
		console.warn(`[permissions] failed to read "${file}":`, error);
	}
}

/** Record a `permission.asked` event and persist it. */
export function recordPermissionAsked(input: PermissionAskedInput): void {
	ensureLoaded();
	apply({ type: 'asked', ...input }, true);
}

/** Record a `permission.replied` event and persist it. */
export function recordPermissionReplied(input: PermissionRepliedInput): void {
	ensureLoaded();
	apply({ type: 'replied', ...input }, true);
}

/** All prompts (pending and answered) as an array, oldest ask first. */
export function listPermissions(): PermissionInfo[] {
	ensureLoaded();
	return [...requests.entries()]
		.sort((a, b) => a[1].askedAt - b[1].askedAt)
		.map(([requestId, request]) => toPermissionInfo(requestId, request));
}

/** Shared join key; `'\0'` cannot occur in session or call ids, so it cannot collide. */
export function permissionKey(sessionId: string, callId: string): string {
	return `${sessionId}\0${callId}`;
}

function toPermissionInfo(requestId: string, request: StoredRequest): PermissionInfo {
	return {
		requestId,
		permission: request.permission,
		patterns: request.patterns,
		reply: request.reply,
		askedAt: request.askedAt,
		repliedAt: request.repliedAt
	};
}

/**
 * The winning prompt per `(sessionId, callId)`, keyed by {@link permissionKey},
 * built in one `O(requests)` pass; `callId === null` gets no entry. Earliest
 * `askedAt` wins; ties keep the first inserted request (skip when `askedAt` is
 * not strictly earlier), matching {@link lookupPermission}.
 */
export function buildPermissionIndex(): Map<string, PermissionInfo> {
	ensureLoaded();
	const index = new Map<string, PermissionInfo>();
	for (const [requestId, request] of requests) {
		if (request.callId === null) continue;
		const key = permissionKey(request.sessionId, request.callId);
		const current = index.get(key);
		if (current !== undefined && current.askedAt <= request.askedAt) continue;
		index.set(key, toPermissionInfo(requestId, request));
	}
	return index;
}

/**
 * The prompt that a tool call triggered, matched by `(sessionId, callId)`.
 * When several asks share a call id (rare), the earliest one wins. Implemented
 * on top of {@link buildPermissionIndex} so the paths cannot drift.
 */
export function lookupPermission(sessionId: string, callId: string | null): PermissionInfo | null {
	if (callId === null) return null;
	return buildPermissionIndex().get(permissionKey(sessionId, callId)) ?? null;
}

/** Test-only: drop the in-memory index so a fresh file is replayed. */
export function resetPermissionStoreForTests(): void {
	loaded = false;
	requests.clear();
}
