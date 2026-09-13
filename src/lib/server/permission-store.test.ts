import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	listPermissions,
	lookupPermission,
	recordPermissionAsked,
	recordPermissionReplied,
	resetPermissionStoreForTests
} from './permission-store';

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'subagentix-perm-'));
	file = join(dir, 'permissions.jsonl');
	process.env.PERMISSIONS_FILE = file;
	resetPermissionStoreForTests();
});

afterEach(() => {
	delete process.env.PERMISSIONS_FILE;
	resetPermissionStoreForTests();
	rmSync(dir, { recursive: true, force: true });
});

describe('permission store', () => {
	test('records an ask and joins it back by session + call id', () => {
		recordPermissionAsked({
			requestId: 'per_1',
			sessionId: 'ses_a',
			callId: 'call_1',
			permission: 'bash',
			patterns: ['git push*'],
			at: 1000
		});
		const found = lookupPermission('ses_a', 'call_1');
		expect(found).toEqual({
			requestId: 'per_1',
			permission: 'bash',
			patterns: ['git push*'],
			reply: null,
			askedAt: 1000,
			repliedAt: null
		});
		expect(lookupPermission('ses_a', 'other')).toBeNull();
		expect(lookupPermission('ses_b', 'call_1')).toBeNull();
	});

	test('attaches the reply to the same request', () => {
		recordPermissionAsked({
			requestId: 'per_2',
			sessionId: 'ses_a',
			callId: 'call_2',
			permission: 'edit',
			patterns: [],
			at: 10
		});
		recordPermissionReplied({ requestId: 'per_2', sessionId: 'ses_a', reply: 'always', at: 20 });
		expect(lookupPermission('ses_a', 'call_2')?.reply).toBe('always');
		expect(lookupPermission('ses_a', 'call_2')?.repliedAt).toBe(20);
	});

	test('keeps the earliest ask when a call id repeats', () => {
		recordPermissionAsked({
			requestId: 'per_late',
			sessionId: 'ses_a',
			callId: 'call_x',
			permission: 'bash',
			patterns: [],
			at: 50
		});
		recordPermissionAsked({
			requestId: 'per_early',
			sessionId: 'ses_a',
			callId: 'call_x',
			permission: 'bash',
			patterns: [],
			at: 5
		});
		expect(lookupPermission('ses_a', 'call_x')?.requestId).toBe('per_early');
	});

	test('replays the JSONL file after a reset, tolerating bad lines', () => {
		recordPermissionAsked({
			requestId: 'per_3',
			sessionId: 'ses_a',
			callId: 'call_3',
			permission: 'read',
			patterns: ['**/.env'],
			at: 1
		});
		recordPermissionReplied({ requestId: 'per_3', sessionId: 'ses_a', reply: 'reject', at: 2 });
		const before = readFileSync(file, 'utf8');
		writeFileSync(file, `not json\n${before}`);

		resetPermissionStoreForTests();
		expect(lookupPermission('ses_a', 'call_3')?.reply).toBe('reject');
		expect(listPermissions()).toHaveLength(1);
	});

	test('a reply without its ask is still kept', () => {
		recordPermissionReplied({ requestId: 'per_orphan', sessionId: 'ses_z', reply: 'once', at: 7 });
		expect(listPermissions()).toEqual([
			{
				requestId: 'per_orphan',
				permission: '',
				patterns: [],
				reply: 'once',
				askedAt: 7,
				repliedAt: 7
			}
		]);
	});
});
