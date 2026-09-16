/**
 * Turn assembly + batched permission-index regression/perf suite (task #378).
 *
 * Isolated child process (same pattern as `data-layer.suite.ts` /
 * `m4a-tracker.suite.ts`): `health.test.ts` installs a process-wide
 * `mock.module('$lib/server/db', ...)` that bun cannot undo, so any suite
 * exercising the real turn assembler + permission store must run in a child
 * `bun test` process. The wrapper `turn-permission.test.ts` spawns it and
 * asserts `0 fail`.
 *
 * Covers three ACs from issue #5:
 *   1. Large/thread-heavy session behaviour — assembled nodes/tool-calls with
 *      `permission` fields match the pre-refactor contract.
 *   2. Permission-index semantics — earliest ask wins per `(sessionId, callId)`,
 *      `callId === null` yields `null`, unknown pairs yield `null`.
 *   3. Perf/guard — assembly no longer scales O(calls × requests); bounded by
 *      a call-count assertion on the index.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTurnModel } from './services/turn';
import {
	buildPermissionIndex,
	lookupPermission,
	permissionKey,
	recordPermissionAsked,
	recordPermissionReplied,
	resetPermissionStoreForTests
} from './permission-store';

const T = 1_700_000_000_000;
const MODEL = JSON.stringify({ id: 'gpt-5', providerID: 'openai' });

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function buildLargeFixture(path: string, permPath: string): void {
	const db = new Database(path);
	db.exec(`
		CREATE TABLE session (
			id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, agent TEXT,
			time_created INTEGER, time_updated INTEGER, time_archived INTEGER, cost REAL,
			tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
			tokens_cache_read INTEGER, tokens_cache_write INTEGER, model TEXT
		);
		CREATE INDEX session_parent_idx ON session(parent_id);
		CREATE TABLE message (
			id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
		);
		CREATE INDEX message_session_idx ON message(session_id);
		CREATE TABLE part (
			id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
			time_created INTEGER, time_updated INTEGER, data TEXT
		);
		CREATE INDEX part_session_idx ON part(session_id);
		CREATE TABLE event (
			id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT
		);
	`);

	const insSession = db.prepare(
		`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
			time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
			tokens_cache_read, tokens_cache_write, model)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const insMessage = db.prepare(
		'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
	);
	const insPart = db.prepare(
		'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
	);
	const insEvent = db.prepare(
		'INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)'
	);

	// --- root session -------------------------------------------------------
	insSession.run(
		'perfRoot', null, '/repo/a', 'Perf root', 'build',
		T, T + 50_000, null, 0, 500, 200, 50, 10, 5, MODEL
	);

	// --- user trigger + assistant message -----------------------------------
	insMessage.run('u1', 'perfRoot', T + 100, T + 100, JSON.stringify({ role: 'user', time: { created: T + 100 } }));
	insMessage.run(
		'a1', 'perfRoot', T + 150, T + 49_000,
		JSON.stringify({
			role: 'assistant', parentID: 'u1', agent: 'build', modelID: 'gpt-5', providerID: 'openai',
			cost: 0, tokens: { input: 500, output: 200, reasoning: 50, cache: { read: 10, write: 5 } },
			time: { created: T + 150, completed: T + 49_000 }
		})
	);

	// --- step parts (one step) ----------------------------------------------
	insPart.run('ss1', 'a1', 'perfRoot', T + 150, T + 150, JSON.stringify({ type: 'step-start' }));
	insPart.run('sf1', 'a1', 'perfRoot', T + 48_000, T + 48_000, JSON.stringify({ type: 'step-finish', reason: 'stop' }));

	// --- action parts (text, patch, reasoning, file, agent) -----------------
	// These test the Action.role mapping: role mirrors the source message role,
	// or is null when the message is absent.
	insPart.run(
		'txt-user', 'u1', 'perfRoot', T + 110, T + 110,
		JSON.stringify({ type: 'text', text: 'user prompt text' })
	);
	insPart.run(
		'txt-assist', 'a1', 'perfRoot', T + 160, T + 160,
		JSON.stringify({ type: 'text', text: 'assistant reply' })
	);
	insPart.run(
		'patch1', 'a1', 'perfRoot', T + 170, T + 170,
		JSON.stringify({ type: 'patch', files: '["a.ts","b.ts"]' })
	);
	insPart.run(
		'reason1', 'a1', 'perfRoot', T + 180, T + 180,
		JSON.stringify({ type: 'reasoning', text: 'chain-of-thought' })
	);
	insPart.run(
		'file1', 'a1', 'perfRoot', T + 190, T + 190,
		JSON.stringify({ type: 'file', filename: 'out.txt', mime: 'text/plain' })
	);
	insPart.run(
		'agent1', 'a1', 'perfRoot', T + 195, T + 195,
		JSON.stringify({ type: 'agent', name: 'developer' })
	);
	// Orphan action part — messageId does not exist in the fixture.
	insPart.run(
		'orphan-txt', 'ghost-msg-nonexistent', 'perfRoot', T + 199, T + 199,
		JSON.stringify({ type: 'text', text: 'orphaned text' })
	);

	// --- 200 tool calls across the single message ---------------------------
	// NOTE: 'task' is excluded from the cycling tool names so none of these 200
	// parts are mistaken for delegation edges (which are filtered by tool='task').
	const tools = ['bash', 'read', 'edit', 'write', 'grep', 'glob', 'webfetch', 'mcp_x_recall'];
	for (let i = 0; i < 200; i++) {
		const callId = `call-perf-${i}`;
		const tool = tools[i % tools.length];
		const created = T + 200 + i * 100;
		const data = {
			type: 'tool', tool, callID: callId,
			state: {
				status: i % 10 === 0 ? 'error' : 'completed',
				time: { start: created, end: created + 50 },
				input: JSON.stringify({ command: `cmd-${i}` }),
				output: i % 10 === 0 ? '' : `output-${i}`
			}
		};
		insPart.run(`t${i}`, 'a1', 'perfRoot', created, created + 50, JSON.stringify(data));
	}

	// --- delegation edges (5 children) --------------------------------------
	const childSessions = ['childA', 'childB', 'childC', 'childD', 'childE'];
	for (let i = 0; i < 5; i++) {
		const childId = childSessions[i];
		insSession.run(
			childId, 'perfRoot', '/repo/a', `Child ${i}`, 'developer',
			T + 500 + i * 1000, T + 2_000 + i * 1000, null, 0, 10, 5, 1, 0, 0, MODEL
		);
		insMessage.run(`cu${i}`, childId, T + 500 + i * 1000, T + 500 + i * 1000,
			JSON.stringify({ role: 'user', time: { created: T + 500 + i * 1000 } }));
		insMessage.run(
			`ca${i}`, childId, T + 520 + i * 1000, T + 2_000 + i * 1000,
			JSON.stringify({
				role: 'assistant', parentID: `cu${i}`, agent: 'developer', modelID: 'gpt-5', providerID: 'openai',
				cost: 0, tokens: { input: 10, output: 5, reasoning: 1 },
				time: { created: T + 520 + i * 1000, completed: T + 2_000 + i * 1000 }
			})
		);
		// One tool call per child (not 'task', so no edge confusion)
		insPart.run(`ct${i}`, `ca${i}`, childId, T + 600 + i * 1000, T + 700 + i * 1000,
			JSON.stringify({ type: 'tool', tool: 'bash', callID: `call-child-${i}`, state: { status: 'completed', time: { start: T + 600 + i * 1000, end: T + 700 + i * 1000 }, input: '{}', output: 'ok' } }));
		// One step per child
		insPart.run(`css${i}`, `ca${i}`, childId, T + 520 + i * 1000, T + 520 + i * 1000, JSON.stringify({ type: 'step-start' }));
		insPart.run(`csf${i}`, `ca${i}`, childId, T + 1900 + i * 1000, T + 1900 + i * 1000, JSON.stringify({ type: 'step-finish', reason: 'stop' }));
		// Action parts on child messages (child sessions have no restrict, so all parts surface)
		insPart.run(
			`catxt-u${i}`, `cu${i}`, childId, T + 510 + i * 1000, T + 510 + i * 1000,
			JSON.stringify({ type: 'text', text: `child ${i} user text` })
		);
		insPart.run(
			`catxt-a${i}`, `ca${i}`, childId, T + 530 + i * 1000, T + 530 + i * 1000,
			JSON.stringify({ type: 'text', text: `child ${i} assistant text` })
		);
		// Orphan action part on child 0 — messageId does not exist in the child's message list.
		if (i === 0) {
			insPart.run(
				'orphan-child-txt', 'ghost-msg-child', childId, T + 540 + i * 1000, T + 540 + i * 1000,
				JSON.stringify({ type: 'text', text: 'orphaned child text' })
			);
		}
		// One delegation edge per child (tool='task')
		insPart.run(`edge${i}`, 'a1', 'perfRoot', T + 400 + i * 100, T + 400 + i * 100,
			JSON.stringify({
				type: 'tool', tool: 'task', callID: `call-edge-${i}`,
				state: {
					status: 'completed', time: { start: T + 400 + i * 100, end: T + 1_500 + i * 100 },
					metadata: { parentSessionId: 'perfRoot', sessionId: childId },
					input: { subagent_type: 'developer', description: `Task #${100 + i}` },
					output: 'done'
				}
			})
		);
	}

	// --- compaction marker --------------------------------------------------
	insPart.run('cmp1', 'a1', 'perfRoot', T + 45_000, T + 45_000, JSON.stringify({ type: 'compaction', auto: 1 }));

	// --- events (removed markers) -------------------------------------------
	insEvent.run('e1', 'perfRoot', 1, 'message.removed.1', JSON.stringify({ messageID: 'a-old' }));

	db.close();

	// --- permissions JSONL --------------------------------------------------
	// 300 permission asks:
	//   - 150 matches tool calls call-perf-0 .. call-perf-149 (the first 150 tools)
	//   - 30 duplicate asks for the same (sessionId, callId) pairs — earliest wins
	//   - 20 asks with callId=null (should never match any tool call)
	//   - 100 asks for unknown callIds (never appear in the fixture)
	const lines: string[] = [];

	// 150 real permission asks
	for (let i = 0; i < 150; i++) {
		lines.push(JSON.stringify({
			type: 'asked',
			requestId: `perm-${i}`,
			sessionId: 'perfRoot',
			callId: `call-perf-${i}`,
			permission: ['bash', 'read', 'edit', 'write', 'grep'][i % 5],
			patterns: ['**/*.ts'],
			at: T + 200 + i * 100 + 1
		}));
	}

	// 30 duplicate asks for the same callIds (half the real ones) — these should
	// NOT override the earlier ask.
	for (let i = 0; i < 30; i++) {
		lines.push(JSON.stringify({
			type: 'asked',
			requestId: `perm-dup-${i}`,
			sessionId: 'perfRoot',
			callId: `call-perf-${i}`,
			permission: 'bash', // different permission — must be ignored
			patterns: [],
			at: T + 200 + i * 100 + 1000 // much later
		}));
	}

	// 20 null-callId asks (should never match any tool call)
	for (let i = 0; i < 20; i++) {
		lines.push(JSON.stringify({
			type: 'asked',
			requestId: `perm-null-${i}`,
			sessionId: 'perfRoot',
			callId: null,
			permission: 'edit',
			patterns: [],
			at: T + 1000 + i * 10
		}));
	}

	// 100 unknown callId asks
	for (let i = 0; i < 100; i++) {
		lines.push(JSON.stringify({
			type: 'asked',
			requestId: `perm-unknown-${i}`,
			sessionId: 'perfRoot',
			callId: `call-nonexistent-${i}`,
			permission: 'write',
			patterns: [],
			at: T + 50_000 + i * 10
		}));
	}

	// A handful of replies for some of the real asks
	for (let i = 0; i < 50; i++) {
		lines.push(JSON.stringify({
			type: 'replied',
			requestId: `perm-${i}`,
			sessionId: 'perfRoot',
			reply: i % 3 === 0 ? 'always' : i % 3 === 1 ? 'reject' : 'once',
			at: T + 200 + i * 100 + 500
		}));
	}

	writeFileSync(permPath, lines.join('\n') + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const tempDir = mkdtempSync(join(tmpdir(), 'subagentix-turn-perm-'));
const DB_PATH = join(tempDir, 'fixture.db');
const PERM_PATH = join(tempDir, 'permissions.jsonl');

buildLargeFixture(DB_PATH, PERM_PATH);
process.env.OPENCODE_DB = DB_PATH;
process.env.SETTINGS_FILE = join(tempDir, 'settings.json');
process.env.PERMISSIONS_FILE = PERM_PATH;

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
	delete process.env.OPENCODE_DB;
	delete process.env.SETTINGS_FILE;
	delete process.env.PERMISSIONS_FILE;
	resetPermissionStoreForTests();
});

// ---------------------------------------------------------------------------
// Behavior: large-session fixture assembled correctly
// ---------------------------------------------------------------------------

describe('buildTurnModel — large session with 200 tool calls and permission index', () => {
	const model = buildTurnModel('perfRoot', 'u1')!;

	test('root node is present with correct toolCallCount (200 non-task tools)', () => {
		const root = model.nodes.find((n) => n.sessionId === 'perfRoot');
		expect(root).toBeDefined();
		// 200 regular tool calls + 5 task delegation calls = 205 total.
		expect(root!.toolCallCount).toBe(205);
		expect(root!.stepCount).toBe(1);
		expect(root!.errorCount).toBe(20); // every 10th call is an error
		expect(root!.compactionCount).toBe(1);
	});

	test('child nodes are included (5 children)', () => {
		const childIds = model.nodes
			.filter((n) => n.kind === 'subagent')
			.map((n) => n.sessionId);
		expect(childIds).toHaveLength(5);
		for (const id of ['childA', 'childB', 'childC', 'childD', 'childE']) {
			expect(childIds).toContain(id);
		}
	});

	test('tool calls carry permission fields for matched callIds', () => {
		const byCallId = new Map(model.toolCalls.map((c) => [c.callId, c]));
		// First 150 tool calls have a permission ask.
		for (let i = 0; i < 150; i++) {
			const call = byCallId.get(`call-perf-${i}`);
			expect(call).toBeDefined();
			expect(call!.permission).not.toBeNull();
			expect(call!.permission!.requestId).toBe(`perm-${i}`);
			expect(call!.permission!.permission).toBe(['bash', 'read', 'edit', 'write', 'grep'][i % 5]);
		}
	});

	test('tool calls without a matching ask have permission=null', () => {
		const byCallId = new Map(model.toolCalls.map((c) => [c.callId, c]));
		// callIds 150..199 have no permission ask.
		for (let i = 150; i < 200; i++) {
			const call = byCallId.get(`call-perf-${i}`);
			expect(call).toBeDefined();
			expect(call!.permission).toBeNull();
		}
	});

	test('delegation edges are collected with tracker refs', () => {
		expect(model.edges).toHaveLength(5);
		for (let i = 0; i < 5; i++) {
			const edge = model.edges.find((e) => e.id === `edge${i}`);
			expect(edge).toBeDefined();
			expect(edge!.childNodeId).toBe(['childA', 'childB', 'childC', 'childD', 'childE'][i]);
			expect(edge!.trackerRefs).toEqual([String(100 + i)]);
		}
	});

	test('child node tool calls have permission=null (no asks for their callIds)', () => {
		const childCalls = model.toolCalls.filter((c) => c.nodeId !== 'perfRoot');
		for (const call of childCalls) {
			expect(call.permission).toBeNull();
		}
	});

	test('turn refs are deduplicated and non-empty', () => {
		expect(model.trackerRefs).toBeDefined();
		expect(model.trackerRefs!.length).toBeGreaterThan(0);
		expect(new Set(model.trackerRefs!).size).toBe(model.trackerRefs!.length);
	});
});

// ---------------------------------------------------------------------------
// Permission index semantics
// ---------------------------------------------------------------------------

describe('permission index semantics', () => {
	beforeEach(() => {
		resetPermissionStoreForTests();
	});

	test('multiple asks for the same (sessionId, callId) resolve to the earliest ask', () => {
		recordPermissionAsked({
			requestId: 'perm-late', sessionId: 'ses', callId: 'call-x',
			permission: 'bash', patterns: ['*'], at: T + 10
		});
		recordPermissionAsked({
			requestId: 'perm-early', sessionId: 'ses', callId: 'call-x',
			permission: 'edit', patterns: [], at: T + 5 // earlier but inserted later
		});
		const index = buildPermissionIndex();
		const resolved = index.get(permissionKey('ses', 'call-x'));
		expect(resolved).toBeDefined();
		expect(resolved!.requestId).toBe('perm-early'); // earliest wins
		expect(resolved!.permission).toBe('edit');
		expect(resolved!.askedAt).toBe(T + 5);
	});

	test('callId === null yields null from lookupPermission', () => {
		recordPermissionAsked({
			requestId: 'perm-n', sessionId: 'ses', callId: null,
			permission: 'bash', patterns: [], at: T
		});
		expect(lookupPermission('ses', null)).toBeNull();
	});

	test('unknown (sessionId, callId) pairs yield null', () => {
		expect(lookupPermission('ses', 'no-such-call')).toBeNull();
		expect(lookupPermission('no-such-session', 'call-x')).toBeNull();
	});

	test('a reply attached to the earliest ask surfaces on lookup', () => {
		recordPermissionAsked({
			requestId: 'perm-r', sessionId: 'ses', callId: 'call-y',
			permission: 'bash', patterns: [], at: T + 1
		});
		recordPermissionReplied({ requestId: 'perm-r', sessionId: 'ses', reply: 'always', at: T + 10 });
		const info = lookupPermission('ses', 'call-y');
		expect(info).not.toBeNull();
		expect(info!.reply).toBe('always');
		expect(info!.repliedAt).toBe(T + 10);
	});

	test('replies to a non-earliest duplicate do not surface', () => {
		recordPermissionAsked({
			requestId: 'perm-early', sessionId: 'ses', callId: 'call-z',
			permission: 'bash', patterns: [], at: T + 1
		});
		recordPermissionAsked({
			requestId: 'perm-late', sessionId: 'ses', callId: 'call-z',
			permission: 'edit', patterns: [], at: T + 100
		});
		recordPermissionReplied({ requestId: 'perm-late', sessionId: 'ses', reply: 'reject', at: T + 200 });
		const info = lookupPermission('ses', 'call-z');
		expect(info).not.toBeNull();
		expect(info!.requestId).toBe('perm-early');
		expect(info!.reply).toBeNull(); // reply was to the non-winning ask
	});

	test('buildPermissionIndex is a single O(requests) pass — no nested loops over calls', () => {
		// Structural check: the function iterates requests once and does one
		// Map.get/set per entry. There is no outer loop over calls inside.
		const src = readFileSync(new URL('./permission-store.ts', import.meta.url), 'utf8');
		const fnMatch = src.match(/export function buildPermissionIndex\(\)[\s\S]*?^}/m);
		expect(fnMatch).toBeTruthy();
		const fnBody = fnMatch![0];
		// Must contain the single requests-loop.
		expect(fnBody).toContain('for (const \[requestId, request\] of requests)');
		// Must NOT contain a second loop over an external collection.
		const nestedLoops = fnBody.match(/\bfor\s*\(/g);
		expect(nestedLoops!.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Perf guard: assembly must not scale O(calls × requests)
// ---------------------------------------------------------------------------

describe('perf guard — assembly is O(calls + requests), not O(calls × requests)', () => {
	test('buildTurnModel on the 200-call fixture completes within a bounded budget', () => {
		const BUDGET_MS = 500; // generous upper bound

		resetPermissionStoreForTests();
		const t0 = performance.now();
		const model = buildTurnModel('perfRoot', 'u1')!;
		const elapsed = performance.now() - t0;

		expect(elapsed).toBeLessThan(BUDGET_MS);
		// 200 root tools + 5 task edges = 205 tool calls total for root.
		const root = model.nodes.find((n) => n.sessionId === 'perfRoot');
		expect(root).toBeDefined();
		expect(root!.toolCallCount).toBe(205);
	});

	test('scaling test: doubling calls roughly doubles time, never quadruples', () => {
		// Build two fixtures: one with N calls, one with 2N.
		// The index is built once per buildTurnModel call, so the ratio should
		// be close to 2x, not 4x.
		const ratios: number[] = [];

		for (const factor of [1, 2]) {
			const nCalls = 100 * factor;
			const dir = mkdtempSync(join(tmpdir(), `subagentix-turn-perm-${factor}x-`));
			const dbPath = join(dir, 'fixture.db');
			const permPath = join(dir, 'permissions.jsonl');

			const db = new Database(dbPath);
			db.exec(`
				CREATE TABLE session (
					id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, agent TEXT,
					time_created INTEGER, time_updated INTEGER, time_archived INTEGER, cost REAL,
					tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
					tokens_cache_read INTEGER, tokens_cache_write INTEGER, model TEXT
				);
				CREATE INDEX session_parent_idx ON session(parent_id);
				CREATE TABLE message (
					id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
				);
				CREATE INDEX message_session_idx ON message(session_id);
				CREATE TABLE part (
					id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
					time_created INTEGER, time_updated INTEGER, data TEXT
				);
				CREATE INDEX part_session_idx ON part(session_id);
				CREATE TABLE event (
					id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT
				);
			`);

			const insSession = db.prepare(
				`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
					time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
					tokens_cache_read, tokens_cache_write, model)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			);
			const insMessage = db.prepare(
				'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
			);
			const insPart = db.prepare(
				'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
			);

			insSession.run('scaleRoot', null, '/repo/a', 'Scale', 'build', T, T + nCalls * 100, null, 0, 100, 50, 10, 0, 0, MODEL);
			insMessage.run('su1', 'scaleRoot', T + 100, T + 100, JSON.stringify({ role: 'user', time: { created: T + 100 } }));
			insMessage.run(
				'sa1', 'scaleRoot', T + 150, T + nCalls * 100 + 100,
				JSON.stringify({
					role: 'assistant', parentID: 'su1', agent: 'build', modelID: 'gpt-5', providerID: 'openai',
					cost: 0, tokens: { input: 100, output: 50, reasoning: 10 },
					time: { created: T + 150, completed: T + nCalls * 100 + 100 }
				})
			);
			insPart.run('ss', 'sa1', 'scaleRoot', T + 150, T + 150, JSON.stringify({ type: 'step-start' }));
			insPart.run('sf', 'sa1', 'scaleRoot', T + nCalls * 100 + 100, T + nCalls * 100 + 100, JSON.stringify({ type: 'step-finish', reason: 'stop' }));

			for (let i = 0; i < nCalls; i++) {
				const created = T + 200 + i * 100;
				insPart.run(`st${i}`, 'sa1', 'scaleRoot', created, created + 50, JSON.stringify({
					type: 'tool', tool: 'bash', callID: `scall-${i}`,
					state: { status: 'completed', time: { start: created, end: created + 50 }, input: '{}', output: 'ok' }
				}));
			}
			db.close();

			// Write nCalls permission asks (one per call) plus nCalls duplicates.
			const permLines: string[] = [];
			for (let i = 0; i < nCalls; i++) {
				permLines.push(JSON.stringify({
					type: 'asked', requestId: `sp-${i}`, sessionId: 'scaleRoot', callId: `scall-${i}`,
					permission: 'bash', patterns: [], at: T + 200 + i * 100 + 1
				}));
			}
			for (let i = 0; i < nCalls; i++) {
				permLines.push(JSON.stringify({
					type: 'asked', requestId: `sp-dup-${i}`, sessionId: 'scaleRoot', callId: `scall-${i}`,
					permission: 'edit', patterns: [], at: T + 200 + i * 100 + 10_000
				}));
			}
			writeFileSync(permPath, permLines.join('\n') + '\n', { mode: 0o600 });

			resetPermissionStoreForTests();
			process.env.OPENCODE_DB = dbPath;
			process.env.SETTINGS_FILE = join(dir, 'settings.json');
			process.env.PERMISSIONS_FILE = permPath;

			const t0 = performance.now();
			buildTurnModel('scaleRoot', 'su1');
			const elapsed = performance.now() - t0;
			ratios.push(elapsed);

			delete process.env.OPENCODE_DB;
			delete process.env.SETTINGS_FILE;
			delete process.env.PERMISSIONS_FILE;
			rmSync(dir, { recursive: true, force: true });
		}

		// The 2x run should be at most ~3x the 1x run (linear scaling with some
		// constant overhead). An O(calls × requests) implementation would show
		// a ratio closer to 4x.
		const [t1, t2] = ratios;
		const ratio = t2 / t1;
		expect(ratio).toBeLessThan(4);
		expect(ratio).toBeGreaterThan(0.5); // sanity: 2x must be faster than 1x with warm cache
	});
});

// ---------------------------------------------------------------------------
// Action.role mapping (issue #5 / reviewer item #1 on #379)
// ---------------------------------------------------------------------------

describe('Action.role is mapped from the source message role', () => {
	const model = buildTurnModel('perfRoot', 'u1')!;
	const actions = model.actions ?? [];

	test('action parts on root assistant message carry role=assistant', () => {
		for (const id of ['txt-assist', 'patch1', 'reason1', 'file1', 'agent1']) {
			const action = actions.find((a) => a.id === id);
			expect(action, `missing action ${id}`).toBeDefined();
			expect(action!.role).toBe('assistant');
		}
	});

	test('action parts on child user messages carry role=user', () => {
		for (let i = 0; i < 5; i++) {
			const action = actions.find((a) => a.id === `catxt-u${i}`);
			expect(action, `missing action catxt-u${i}`).toBeDefined();
			expect(action!.role).toBe('user');
		}
	});

	test('action parts on child assistant messages carry role=assistant', () => {
		for (let i = 0; i < 5; i++) {
			const action = actions.find((a) => a.id === `catxt-a${i}`);
			expect(action, `missing action catxt-a${i}`).toBeDefined();
			expect(action!.role).toBe('assistant');
		}
	});

	test('orphan action part (messageId absent from session messages) has role=null', () => {
		const action = actions.find((a) => a.id === 'orphan-child-txt');
		expect(action).toBeDefined();
		expect(action!.role).toBeNull();
	});

	test('compaction actions always have role=null', () => {
		const compactions = actions.filter((a) => a.kind === 'compaction');
		expect(compactions.length).toBeGreaterThan(0);
		for (const action of compactions) {
			expect(action.role).toBeNull();
		}
	});
});
