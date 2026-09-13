/**
 * Live permission-event collector.
 *
 * Subscribes to the opencode web server's SSE bus (`GET {base}/event`) and
 * feeds `permission.asked` / `permission.replied` events into
 * {@link permission-store}. This is the only source for permission history:
 * opencode does not persist these events. The collector reconnects with
 * exponential backoff and is started once from `hooks.server.ts`.
 */
import {
	recordPermissionAsked,
	recordPermissionReplied,
	type PermissionReply
} from './permission-store';

/** Default opencode web server address on this host. */
export const DEFAULT_OPENCODE_BASE_URL = 'http://127.0.0.1:1234';

let started = false;

/** The opencode HTTP base URL: `OPENCODE_BASE_URL` -> localhost default. */
export function resolveOpencodeBaseUrl(): string {
	const raw = process.env.OPENCODE_BASE_URL?.trim();
	return (raw && raw !== '' ? raw : DEFAULT_OPENCODE_BASE_URL).replace(/\/+$/, '');
}

interface BusEvent {
	type?: unknown;
	properties?: unknown;
	data?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/** The `callID` an ask maps to, from either the v1 `tool` or v2 `source` shape. */
function askedCallId(payload: Record<string, unknown>): string | null {
	const tool = asRecord(payload.tool);
	const source = asRecord(payload.source);
	const callId = tool?.callID ?? source?.callID;
	return typeof callId === 'string' && callId !== '' ? callId : null;
}

function normaliseReply(value: unknown): PermissionReply {
	const raw =
		typeof value === 'string'
			? value
			: value !== null && typeof value === 'object' && 'type' in value
				? String((value as { type: unknown }).type)
				: '';
	return raw === 'always' || raw === 'reject' ? raw : 'once';
}

function handleEvent(event: BusEvent): void {
	const type = typeof event.type === 'string' ? event.type : '';
	const payload = asRecord(event.properties) ?? asRecord(event.data);
	if (!payload) return;

	if (type === 'permission.asked' || type === 'permission.v2.asked') {
		const requestId = payload.id;
		const sessionId = payload.sessionID;
		if (typeof requestId !== 'string' || typeof sessionId !== 'string') return;
		const permission = payload.permission ?? payload.action;
		const at = typeof payload.time === 'number' ? payload.time : Date.now();
		recordPermissionAsked({
			requestId,
			sessionId,
			callId: askedCallId(payload),
			permission: typeof permission === 'string' ? permission : '',
			patterns: asStringArray(payload.patterns ?? payload.resources),
			at
		});
		return;
	}

	if (type === 'permission.replied' || type === 'permission.v2.replied') {
		const requestId = payload.requestID;
		const sessionId = payload.sessionID;
		if (typeof requestId !== 'string' || typeof sessionId !== 'string') return;
		recordPermissionReplied({
			requestId,
			sessionId,
			reply: normaliseReply(payload.reply),
			at: Date.now()
		});
	}
}

function handleBlock(block: string): void {
	for (const line of block.split('\n')) {
		if (!line.startsWith('data:')) continue;
		const json = line.slice(5).trim();
		if (json === '') continue;
		try {
			handleEvent(JSON.parse(json) as BusEvent);
		} catch {
			// Ignore a malformed frame; the stream keeps flowing.
		}
	}
}

async function consume(body: ReadableStream<Uint8Array>): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) return;
		buffer += decoder.decode(value, { stream: true });
		let index = buffer.indexOf('\n\n');
		while (index !== -1) {
			handleBlock(buffer.slice(0, index));
			buffer = buffer.slice(index + 2);
			index = buffer.indexOf('\n\n');
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(base: string): Promise<void> {
	let delay = 1_000;
	for (;;) {
		try {
			const response = await fetch(`${base}/event`, {
				headers: { accept: 'text/event-stream' }
			});
			if (!response.ok || response.body === null) {
				throw new Error(`unexpected response ${response.status}`);
			}
			delay = 1_000;
			await consume(response.body);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`[permissions] event stream error: ${message}`);
		}
		await sleep(delay);
		delay = Math.min(delay * 2, 30_000);
	}
}

/**
 * Start the collector once. Safe to call from module top-level (idempotent);
 * the reconnect loop owns its own lifecycle for the process lifetime.
 */
export function startPermissionCollector(): void {
	if (started) return;
	started = true;
	void run(resolveOpencodeBaseUrl());
}
