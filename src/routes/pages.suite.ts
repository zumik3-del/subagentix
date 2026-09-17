/**
 * M3a production-build suite (task #188, ADR §4.5 / §7.1 / §7.2).
 *
 * Isolated child process. It (1) builds the app, (2) guards the client bundle
 * against server-only references (`bun:sqlite` / `opencode.db` / `OPENCODE_DB`),
 * and (3) boots the real `adapter-node` server against throwaway fixture DBs to
 * assert the dashboard home shell (task #404: header + grid + skeletons), the
 * session header + Gantt page (no turn list), and that the DB-unavailable path
 * returns a non-crashing 503 page for the session route while the shell still
 * renders.
 *
 * The live opencode DB is never opened or written.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTimeScale, FALLBACK_CHART_W, orderNodes } from '$lib/model/gantt';
import type { Node } from '$lib/model/types';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const buildIndex = join(repoRoot, 'build', 'index.js');
const clientDir = join(repoRoot, 'build', 'client');

const tempDirs: string[] = [];
const running: Array<() => Promise<void>> = [];

const T = 1_700_000_000_000;
const MODEL = JSON.stringify({ id: 'gpt-5', providerID: 'openai' });

const SCHEMA = `
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
`;

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** A valid DB: one root session with one turn, plus a child delegation. */
function buildPopulatedDb(path: string): void {
	const db = new Database(path);
	db.exec(SCHEMA);
	const session = db.prepare(
		`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
			time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
			tokens_cache_read, tokens_cache_write, model)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	session.run('root1', null, '/repo/a', 'Root one', 'build', T, T + 900, null, 2, 310, 125, 40, 20, 10, MODEL);
	session.run('child1', 'root1', '/repo/a', 'Child one', 'developer', T + 500, T + 800, null, 0.5, 50, 20, 10, 0, 0, MODEL);

	const message = db.prepare(
		'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
	);
	message.run('u1', 'root1', T + 100, T + 100, JSON.stringify({ role: 'user', time: { created: T + 100 } }));
	message.run(
		'a1',
		'root1',
		T + 150,
		T + 900,
		JSON.stringify({
			role: 'assistant',
			parentID: 'u1',
			agent: 'build',
			modelID: 'gpt-5',
			providerID: 'openai',
			cost: 2,
			tokens: { input: 300, output: 120, reasoning: 40, cache: { read: 20, write: 10 } },
			time: { created: T + 150, completed: T + 900 }
		})
	);

	const part = db.prepare(
		'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
	);
	part.run('s1', 'a1', 'root1', T + 150, T + 150, JSON.stringify({ type: 'step-start' }));
	part.run(
		'f1',
		'a1',
		'root1',
		T + 900,
		T + 900,
		JSON.stringify({ type: 'step-finish', reason: 'stop', tokens: { input: 150, output: 60, reasoning: 20, cache: { read: 10, write: 5 } }, cost: 1 })
	);
	part.run(
		'd1',
		'a1',
		'root1',
		T + 500,
		T + 500,
		JSON.stringify({
			type: 'tool',
			tool: 'task',
			callID: 'c1',
			state: {
				status: 'completed',
				time: { start: T + 500, end: T + 800 },
				metadata: { parentSessionId: 'root1', sessionId: 'child1' },
				input: { subagent_type: 'developer', description: 'build' },
				output: 'result'
			}
		})
	);
	db.close();
}

/** A valid, empty DB (schema present, zero sessions) for the empty-state page. */
function buildEmptyDb(path: string): void {
	const db = new Database(path);
	db.exec(SCHEMA);
	db.close();
}

/**
 * Crafted M3b fixture for the turn-Gantt SSR smoke. A single turn (`u1`) is
 * shaped to exercise the SVG Gantt end-to-end: 5 node rows, 6 delegation edges
 * (two to `child1` -> multiSpawn, one before the first trigger -> orphanEdge on
 * the root, one childless -> noChild), a running node/open step (`runChild`),
 * a 4-way tool mix, a clamped span, a future end, an overlap past the next
 * trigger, and compaction + removed markers.
 */
function buildGanttDb(path: string): void {
	const db = new Database(path);
	db.exec(SCHEMA);
	const session = db.prepare(
		`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
			time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
			tokens_cache_read, tokens_cache_write, model)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const message = db.prepare(
		'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
	);
	const part = db.prepare(
		'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
	);
	const event = db.prepare(
		'INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)'
	);

	// Anchor the fixture near "now" so the live `Date.now()` clamps stay sane and
	// the derived chart stays small (a 2023 anchor would inflate the tick count).
	const G = Date.now() - 60_000;
	const future = Date.now() + 5_000;

	session.run('root1', null, '/repo/a', 'Gantt root', 'build', G, G + 20_000, null, 3, 310, 125, 40, 20, 10, MODEL);
	session.run('child1', 'root1', '/repo/a', 'Child', 'developer', G + 2_000, G + 2_600, null, 0.5, 50, 20, 10, 0, 0, MODEL);
	session.run('clampChild', 'root1', '/repo/a', 'Clamped', 'tester', G + 4_000, G + 3_900, null, 0, 0, 0, 0, 0, 0, null);
	session.run('futureChild', 'root1', '/repo/a', 'Future', 'reviewer', G + 5_000, future, null, 0, 0, 0, 0, 0, 0, MODEL);
	session.run('runChild', 'root1', '/repo/a', 'Running', 'developer', G + 6_000, G + 6_100, null, 0, 0, 0, 0, 0, 0, MODEL);

	// Two root turns: u1 is the requested turn, u2 exists so `overlapsNextTurn`
	// can fire (a1 ends after u2 starts).
	message.run('u1', 'root1', G + 1_000, G + 1_000, JSON.stringify({ role: 'user', time: { created: G + 1_000 } }));
	message.run('u2', 'root1', G + 9_000, G + 9_000, JSON.stringify({ role: 'user', time: { created: G + 9_000 } }));
	message.run(
		'a1',
		'root1',
		G + 1_100,
		G + 12_000,
		JSON.stringify({
			role: 'assistant',
			parentID: 'u1',
			agent: 'build',
			modelID: 'gpt-5',
			providerID: 'openai',
			cost: 1,
			tokens: { input: 300, output: 120, reasoning: 40, cache: { read: 20, write: 10 } },
			time: { created: G + 1_100, completed: G + 12_000 }
		})
	);

	part.run('s1', 'a1', 'root1', G + 1_100, G + 1_100, JSON.stringify({ type: 'step-start' }));
	part.run(
		'f1',
		'a1',
		'root1',
		G + 12_000,
		G + 12_000,
		JSON.stringify({ type: 'step-finish', reason: 'stop', tokens: { input: 150, output: 60, reasoning: 20, cache: { read: 10, write: 5 } }, cost: 1 })
	);
	part.run(
		'bash1',
		'a1',
		'root1',
		G + 1_200,
		G + 1_400,
		JSON.stringify({ type: 'tool', tool: 'bash', callID: 'c-bash', state: { status: 'completed', time: { start: G + 1_200, end: G + 1_400 }, input: '{}', output: 'ok' } })
	);
	part.run(
		'mcp1',
		'a1',
		'root1',
		G + 1_500,
		G + 1_500,
		JSON.stringify({ type: 'tool', tool: 'mcp_x_recall', callID: 'c-mcp', state: { status: 'error', error: 'boom', time: { start: G + 1_500, end: G + 1_450 }, input: '{}', output: '' } })
	);
	part.run('cmp1', 'a1', 'root1', G + 8_000, G + 8_000, JSON.stringify({ type: 'compaction', auto: 1 }));

	const task = (
		id: string,
		created: number,
		end: number | null,
		child: string | null,
		status: string,
		error?: string
	) =>
		part.run(
			id,
			'a1',
			'root1',
			created,
			created,
			JSON.stringify({
				type: 'tool',
				tool: 'task',
				callID: `c-${id}`,
				state: {
					status,
					...(error ? { error } : {}),
					time: end === null ? { start: created } : { start: created, end },
					metadata: child === null ? { parentSessionId: 'root1' } : { parentSessionId: 'root1', sessionId: child },
					input: { subagent_type: 'developer' },
					output: ''
				}
			})
		);

	// Before the first trigger -> orphanEdge; a second edge to child1 -> multiSpawn.
	task('d_orphan', G + 500, G + 700, 'child1', 'completed');
	task('d1', G + 2_000, G + 2_600, 'child1', 'completed');
	task('d_nochild', G + 3_000, G + 3_100, null, 'error', 'spawn failed');
	task('d_clamp', G + 4_000, G + 4_100, 'clampChild', 'completed');
	task('d_future', G + 5_000, G + 5_100, 'futureChild', 'completed');
	task('d_run', G + 6_000, null, 'runChild', 'running');

	// child1: a closed step + one non-delegation tool.
	message.run('cu1', 'child1', G + 2_000, G + 2_000, JSON.stringify({ role: 'user', time: { created: G + 2_000 } }));
	message.run('ca1', 'child1', G + 2_100, G + 2_600, JSON.stringify({ role: 'assistant', parentID: 'cu1', agent: 'developer', modelID: 'gpt-5', providerID: 'openai', cost: 0.5, tokens: { input: 50, output: 20, reasoning: 10 }, time: { created: G + 2_100, completed: G + 2_600 } }));
	part.run('s1c', 'ca1', 'child1', G + 2_100, G + 2_100, JSON.stringify({ type: 'step-start' }));
	part.run('f1c', 'ca1', 'child1', G + 2_600, G + 2_600, JSON.stringify({ type: 'step-finish', reason: 'stop', tokens: { input: 50, output: 20, reasoning: 10 }, cost: 0.5 }));
	part.run('read1', 'ca1', 'child1', G + 2_200, G + 2_300, JSON.stringify({ type: 'tool', tool: 'read', callID: 'c-read', state: { status: 'completed', time: { start: G + 2_200, end: G + 2_300 }, input: '{}', output: 'x' } }));

	// runChild: no completed step -> open step + running node + running tool.
	message.run('ra1', 'runChild', G + 6_000, G + 6_100, JSON.stringify({ role: 'assistant', agent: 'developer', modelID: 'gpt-5', providerID: 'openai', cost: 0, tokens: { input: 10, output: 5, reasoning: 2 }, time: { created: G + 6_000 } }));
	part.run('s1r', 'ra1', 'runChild', G + 6_000, G + 6_000, JSON.stringify({ type: 'step-start' }));
	part.run('bashr', 'ra1', 'runChild', G + 6_050, G + 6_050, JSON.stringify({ type: 'tool', tool: 'bash', callID: 'c-bash-run', state: { status: 'running', time: { start: G + 6_050 }, input: '{}', output: '' } }));

	// futureChild: a completed end in the future -> futureEnd clamp.
	message.run('fa1', 'futureChild', G + 5_000, future, JSON.stringify({ role: 'assistant', agent: 'reviewer', modelID: 'gpt-5', providerID: 'openai', cost: 0, tokens: { input: 0, output: 0, reasoning: 0 }, time: { created: G + 5_000, completed: future } }));

	// Removed content marker.
	event.run('ev1', 'root1', 1, 'message.removed.1', JSON.stringify({ messageID: 'gone' }));

	db.close();
}

/**
 * Deterministic SHORT turn fixture for the M3b time-scale fix (task #193/#194):
 * one root node spanning exactly 15 s, fully in the past and not running, so
 * `turnExtent` is fixed. With the width-fitted scale (task #224) the single bar
 * must fill the 720 px fallback chart; the old fixed 0.02 px/ms scale stopped it
 * at 0.02 * 15_000 = 300 px.
 */
function buildShortTurnDb(path: string): void {
	const db = new Database(path);
	db.exec(SCHEMA);
	const session = db.prepare(
		`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
			time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
			tokens_cache_read, tokens_cache_write, model)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const message = db.prepare(
		'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
	);

	const S = Date.now() - 300_000;
	session.run('shortroot', null, '/repo/short', 'Short turn', 'build', S, S + 15_000, null, 0, 0, 0, 0, 0, 0, MODEL);
	message.run('su1', 'shortroot', S, S, JSON.stringify({ role: 'user', time: { created: S } }));
	message.run(
		'sa1',
		'shortroot',
		S,
		S + 15_000,
		JSON.stringify({
			role: 'assistant',
			parentID: 'su1',
			agent: 'build',
			modelID: 'gpt-5',
			providerID: 'openai',
			cost: 0,
			tokens: { input: 0, output: 0, reasoning: 0 },
			time: { created: S, completed: S + 15_000 }
		})
	);
	db.close();
}

/**
 * RUNNING turn fixture: the root assistant has no completion time, so the node
 * bar is hatched and stretches to `turnExtent.end` (= now). Carries a `removed`
 * marker (no timestamp) to assert it is anchored to the data edge under the
 * derived scale rather than pinned to a chart edge the data never reaches.
 */
function buildRunningTurnDb(path: string): void {
	const db = new Database(path);
	db.exec(SCHEMA);
	const session = db.prepare(
		`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
			time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
			tokens_cache_read, tokens_cache_write, model)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const message = db.prepare(
		'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
	);
	const event = db.prepare(
		'INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)'
	);

	const R = Date.now() - 6_000;
	session.run('runroot', null, '/repo/run', 'Running turn', 'build', R, R, null, 0, 0, 0, 0, 0, 0, MODEL);
	message.run('ru1', 'runroot', R, R, JSON.stringify({ role: 'user', time: { created: R } }));
	message.run(
		'ra1',
		'runroot',
		R,
		R,
		JSON.stringify({
			role: 'assistant',
			parentID: 'ru1',
			agent: 'build',
			modelID: 'gpt-5',
			providerID: 'openai',
			cost: 0,
			tokens: { input: 0, output: 0, reasoning: 0 }
		})
	);
	event.run('rev', 'runroot', 1, 'message.removed.1', JSON.stringify({ messageID: 'gone' }));
	db.close();
}

/**
 * Deterministic LONG turn fixture: a single completed root node spanning 120 s,
 * fully in the past. The width-fitted scale (task #224) compresses it into the
 * 720 px fallback chart used before the container is measured, so there is no
 * horizontal overflow to scroll.
 */
function buildLongTurnDb(path: string): void {
	const db = new Database(path);
	db.exec(SCHEMA);
	const session = db.prepare(
		`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
			time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
			tokens_cache_read, tokens_cache_write, model)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const message = db.prepare(
		'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
	);

	const L = Date.now() - 400_000;
	session.run('longroot', null, '/repo/long', 'Long turn', 'build', L, L + 120_000, null, 0, 0, 0, 0, 0, 0, MODEL);
	message.run('lu1', 'longroot', L, L, JSON.stringify({ role: 'user', time: { created: L } }));
	message.run(
		'la1',
		'longroot',
		L,
		L + 120_000,
		JSON.stringify({
			role: 'assistant',
			parentID: 'lu1',
			agent: 'build',
			modelID: 'gpt-5',
			providerID: 'openai',
			cost: 0,
			tokens: { input: 0, output: 0, reasoning: 0 },
			time: { created: L, completed: L + 120_000 }
		})
	);
	db.close();
}

/**
 * U1 shell fixture: 35 root sessions, each with one trigger/reply pair, so the
 * sidebar's first page (30) renders while `total > 30` shows `Load more`, and
 * any session in the seeded window can be the URL-active one. Newest-first is
 * `shell34`..`shell00`.
 */
function buildShellDb(path: string): void {
	const db = new Database(path);
	db.exec(SCHEMA);
	const session = db.prepare(
		`INSERT INTO session (id, parent_id, directory, title, agent, time_created, time_updated,
			time_archived, cost, tokens_input, tokens_output, tokens_reasoning,
			tokens_cache_read, tokens_cache_write, model)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const message = db.prepare(
		'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
	);
	for (let i = 0; i < 35; i++) {
		const id = `shell${String(i).padStart(2, '0')}`;
		const created = T + i * 1_000;
		session.run(id, null, '/repo/shell', `Shell ${i}`, 'build', created, created + 900, null, 0, 0, 0, 0, 0, 0, MODEL);
		message.run(`${id}-u`, id, created + 100, created + 100, JSON.stringify({ role: 'user', time: { created: created + 100 } }));
		message.run(
			`${id}-a`,
			id,
			created + 150,
			created + 150,
			JSON.stringify({
				role: 'assistant',
				parentID: `${id}-u`,
				agent: 'build',
				modelID: 'gpt-5',
				providerID: 'openai',
				cost: 0,
				tokens: { input: 1, output: 1, reasoning: 0 },
				time: { created: created + 150, completed: created + 800 }
			})
		);
	}
	db.close();
}

function walkFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkFiles(full));
		else out.push(full);
	}
	return out;
}

async function runBuild(): Promise<void> {
	const proc = Bun.spawn(['bun', 'run', 'build'], {
		cwd: repoRoot,
		env: process.env,
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	]);
	if (code !== 0) throw new Error(`production build failed (${code}):\n${out}\n${err}`);
}

interface ServerHandle {
	base: string;
	stop: () => Promise<void>;
}

async function startServer(dbPath: string): Promise<ServerHandle> {
	let lastError = 'unknown';
	for (let attempt = 0; attempt < 3; attempt++) {
		const port = 32_000 + Math.floor(Math.random() * 20_000);
		const proc = Bun.spawn(['bun', 'run', 'build/index.js'], {
			cwd: repoRoot,
			env: {
				...process.env,
				OPENCODE_DB: dbPath,
				SETTINGS_FILE: `${dbPath}.settings.json`,
				HOST: '127.0.0.1',
				PORT: String(port)
			},
			stdout: 'pipe',
			stderr: 'pipe'
		});
		const stderrText = new Response(proc.stderr).text();
		const base = `http://127.0.0.1:${port}`;
		const deadline = Date.now() + 20_000;

		while (Date.now() < deadline) {
			if (proc.exitCode !== null) {
				lastError = `server exited early (${proc.exitCode}): ${await stderrText}`;
				break;
			}
			try {
				// Any HTTP response (200 or 503) means the server is listening.
				await fetch(`${base}/api/health`);
				const stop = async () => {
					proc.kill();
					await proc.exited;
				};
				running.push(stop);
				return { base, stop };
			} catch {
				await Bun.sleep(100);
			}
		}
		proc.kill();
		await proc.exited;
	}
	throw new Error(`built server did not become ready: ${lastError}`);
}

async function getHtml(base: string, path: string): Promise<{ status: number; body: string }> {
	const response = await fetch(`${base}${path}`);
	return { status: response.status, body: await response.text() };
}

/**
 * Extract the resolved GanttModel from a streamed SSR response.
 *
 * With async `data.gantt` (task #385), the body's HTML contains the skeleton
 * and a trailing `<script>__sveltekit_X.resolve(N, () => [MODEL])</script>`
 * carries the resolved model. This helper parses that script and returns the
 * deserialised model (or null when absent / when ?turn=null).
 */
function extractDeferredGantt(body: string): unknown | null {
	const m = body.match(
		/__sveltekit_\w+\.resolve\(\d+, \(\) => \[([\s\S]*?)\]\)\s*<\/script>/
	);
	if (!m) return null;
	try {
		// The deferred payload is a JS object literal (devalue-style, unquoted
		// keys), not JSON. It comes from our own SSR response, so evaluating it
		// in the test process is safe.
		return new Function(`return (${m[1]});`)();
	} catch {
		return null;
	}
}

/** Concatenated production CSS emitted into `build/client/**` (after `runBuild`). */
function builtCss(): string {
	return walkFiles(clientDir)
		.filter((file) => file.endsWith('.css'))
		.map((file) => readFileSync(file, 'utf8'))
		.join('\n');
}

/** Rendered `width` (px) of the chart SVG. */
function parseChartWidth(html: string): number {
	const match = html.match(/<svg class="chart[^"]*" width="([\d.]+)"/);
	if (!match) throw new Error('chart <svg> not found in SSR HTML');
	return Number(match[1]);
}

/** `x`/`width` of a node-span bar (`rx="3"`) inside the group labelled `ariaLabel`. */
function parseNodeBar(html: string, ariaLabel: string): { x: number; width: number } {
	const match = html.match(
		new RegExp(
			`aria-label="${ariaLabel}"[\\s\\S]*?<rect x="([\\d.]+)" y="[\\d.]+" width="([\\d.]+)" height="[\\d.]+" rx="3"`
		)
	);
	if (!match) throw new Error(`node bar for "${ariaLabel}" not found`);
	return { x: Number(match[1]), width: Number(match[2]) };
}

/** `x`/`width` of the unique rect filled with `url(#<patternId>)`. */
function parsePatternRect(html: string, patternId: string): { x: number; width: number } {
	const match = html.match(
		new RegExp(
			`<rect x="([\\d.]+)" y="[\\d.]+" width="([\\d.]+)" height="[\\d.]+" rx="[\\d.]+" fill="url\\(#${patternId}\\)"`
		)
	);
	if (!match) throw new Error(`rect with fill url(#${patternId}) not found`);
	return { x: Number(match[1]), width: Number(match[2]) };
}

/**
 * Count rendered `class="…"` attributes whose class-token list contains every
 * `token`. Tolerates the Svelte scoped-class suffix and any attribute order,
 * and treats `row-session`/`selected` as whole tokens so `row-session` never
 * matches some other class by substring.
 */
function countElementClasses(html: string, ...tokens: string[]): number {
	return [...html.matchAll(/class="([^"]*)"/g)].filter((match) => {
		const classes = match[1].split(/\s+/);
		return tokens.every((token) => classes.includes(token));
	}).length;
}

beforeAll(async () => {
	await runBuild();
}, 120_000);

afterAll(async () => {
	for (const stop of running) await stop();
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('server-leak guard (build/client/**)', () => {
	test('client bundle carries no server-only references', () => {
		if (!existsSync(clientDir)) mkdirSync(clientDir, { recursive: true });
		const files = walkFiles(clientDir);
		expect(files.length).toBeGreaterThan(0);

		const forbidden = /bun:sqlite|opencode\.db|OPENCODE_DB/;
		const offenders = files.filter((file) => forbidden.test(readFileSync(file, 'utf8')));
		expect(
			offenders.map((file) => file.slice(repoRoot.length)),
			'server-only string leaked into the client bundle'
		).toEqual([]);
	});
});

describe('SSR #215 — dashboard home + header/Gantt session page', () => {
	test('/ renders the dashboard shell with no session list; /sessions/[id] renders header + Gantt only', async () => {
		const dir = tempDir('subagentix-m3a-pages-');
		const dbPath = join(dir, 'fixture.db');
		buildPopulatedDb(dbPath);

		const server = await startServer(dbPath);
		try {
			// Home is the dashboard shell (task #404): header + responsive grid with
			// one skeleton per selected widget. The tree (sidebar) is still the only
			// session navigation, so the main area carries no session rows or pager.
			const list = await getHtml(server.base, '/');
			expect(list.status).toBe(200);
			expect(list.body).toContain('class="dashboard');
			expect(list.body).toContain('class="widget-grid');
			expect(list.body).toContain('class="skeleton-widget');
			// The default selection is seeded from settings.json (absent -> defaults).
			expect(list.body).toContain('Sessions per day');
			expect(list.body).not.toContain('href="/sessions/');
			expect(list.body).not.toContain('aria-label="Session list pages"');
			expect(list.body).not.toContain('No sessions found.');
			expect(list.body).not.toContain('Showing ');
			// The session still lives in the tree (layout loader), not the page body.
			expect(list.body).toContain('Root one');

			// Session page with ?turn=: header + Gantt, no turn list / no breadcrumb.
			const detail = await getHtml(server.base, '/sessions/root1?turn=u1');
			expect(detail.status).toBe(200);
			expect(detail.body).toMatch(/<h1[^>]*>Root one<\/h1>/);
			// Task #385 (streamed gantt): SSR body has the skeleton, not the Gantt SVG.
			expect(detail.body).toContain('gantt-loading');
			expect(detail.body).toContain('role="status"');
			expect(detail.body).toContain('aria-live="polite"');
			expect(detail.body).not.toContain('← All sessions');
			expect(detail.body).not.toContain('Turns (');
			expect(detail.body).not.toContain('Load older turns');
			expect(detail.body).not.toContain('Newer turns →');
			// Task #237: no page-level Gantt <h2>, no Trigger / assistant-message subtitle.
			expect(detail.body).not.toContain('<h2');
			expect(detail.body).not.toContain('Trigger');
			expect(detail.body).not.toContain('assistant message');
			// Header uses the strong-background token (source-level contract).
			const sessionPage = readFileSync(join(repoRoot, 'src/routes/sessions/[id]/+page.svelte'), 'utf8');
			expect(sessionPage).toContain('background: var(--background-strong)');

			// Without ?turn= the header stays and the page asks for a turn (no Gantt).
			const noTurn = await getHtml(server.base, '/sessions/root1');
			expect(noTurn.status).toBe(200);
			expect(noTurn.body).toMatch(/<h1[^>]*>Root one<\/h1>/);
			expect(noTurn.body).toContain('Select a turn in the session tree to view its Gantt.');
			expect(noTurn.body).not.toContain('aria-label="Turn wall-clock Gantt"');

			// A child session with no turns still renders its header (no turn list).
			const child = await getHtml(server.base, '/sessions/child1');
			expect(child.status).toBe(200);
			expect(child.body).toMatch(/<h1[^>]*>Child one<\/h1>/);
			expect(child.body).toContain('Select a turn in the session tree to view its Gantt.');
			expect(child.body).not.toContain('Turns (');
		} finally {
			await server.stop();
		}
	}, 60_000);
});

describe('SSR dashboard picker + scope (tasks #414/#415)', () => {
		test('/ renders the Widgets button and filter selector in the header actions area', async () => {
			const dir = tempDir('subagentix-dashboard-picker-');
			const dbPath = join(dir, 'fixture.db');
			buildPopulatedDb(dbPath);

			const server = await startServer(dbPath);
			try {
				const page = await getHtml(server.base, '/');
				expect(page.status).toBe(200);
				// Picker control is now an icon-only gear; assert it by its accessible name.
				expect(page.body).toMatch(/<button[^>]*aria-label="Widgets"/);
				// The modal is open=false in SSR, so no dialog markup should appear.
				expect(page.body).not.toContain('role="dialog"');
				expect(page.body).not.toContain('aria-modal');
				expect(page.body).not.toContain('class="widgets-dialog"');
				// Filter selector: period select + project select.
				expect(page.body).toMatch(/<select[^>]*aria-label="Period"/);
				expect(page.body).toMatch(/<select[^>]*aria-label="Project"/);
				// Default period is 7d (task #457), default scope is "all" (every directory).
				expect(page.body).toContain('value="7d"');
				expect(page.body).toContain('value="all"');
				// Default widget selection renders skeletons (6 defaults).
				expect(countElementClasses(page.body, 'skeleton-widget')).toBe(6);
			} finally {
				await server.stop();
			}
		}, 60_000);

		test('zero-selection settings renders the empty state, not the widget grid', async () => {
			const dir = tempDir('subagentix-dashboard-empty-');
			const dbPath = join(dir, 'fixture.db');
			buildPopulatedDb(dbPath);
			// Persist an explicit empty widget selection (simulates post-Apply with zero widgets).
			writeFileSync(`${dbPath}.settings.json`, JSON.stringify({ version: 1, dashboardWidgets: [] }), 'utf8');

			const server = await startServer(dbPath);
			try {
				const page = await getHtml(server.base, '/');
				expect(page.status).toBe(200);
				// No grid, no skeletons.
				expect(page.body).not.toContain('class="widget-grid');
				expect(page.body).not.toContain('class="skeleton-widget');
				// Empty-state paragraph names the gear control (no visible "Widgets" label).
				expect(page.body).toContain(
					'No widgets selected. Use the gear button to add widgets to your dashboard.'
				);
				// The picker control still renders (the user can open it to add widgets).
				expect(page.body).toMatch(/<button[^>]*aria-label="Widgets"/);
			} finally {
				await server.stop();
			}
		}, 60_000);

		test('URL ?period=7d&scope=/repo/a drives the selector values in SSR', async () => {
			const dir = tempDir('subagentix-dashboard-scope-');
			const dbPath = join(dir, 'fixture.db');
			buildPopulatedDb(dbPath);

			const server = await startServer(dbPath);
			try {
				const page = await getHtml(server.base, '/?period=7d&scope=/repo/a');
				expect(page.status).toBe(200);
				// The selects reflect the URL-driven values (parser accepts valid inputs).
				expect(page.body).toContain('value="7d"');
				expect(page.body).toContain('value="/repo/a"');
				// Widget grid still renders with the default persisted selection.
				expect(page.body).toContain('class="widget-grid');
				expect(countElementClasses(page.body, 'skeleton-widget')).toBe(6);
			} finally {
				await server.stop();
			}
		}, 60_000);

		test('URL ?period=invalid&scope=/ghost falls back to defaults', async () => {
			const dir = tempDir('subagentix-dashboard-fallback-');
			const dbPath = join(dir, 'fixture.db');
			buildPopulatedDb(dbPath);

			const server = await startServer(dbPath);
			try {
				const page = await getHtml(server.base, '/?period=invalid&scope=/ghost');
				expect(page.status).toBe(200);
				// Unknown period -> DEFAULT_PERIOD (7d); unknown scope -> null (all).
				expect(page.body).toContain('value="7d"');
				expect(page.body).toContain('value="all"');
			} finally {
				await server.stop();
			}
		}, 60_000);

		test('custom persisted widget selection renders only those widgets as skeletons', async () => {
			const dir = tempDir('subagentix-dashboard-custom-');
			const dbPath = join(dir, 'fixture.db');
			buildPopulatedDb(dbPath);
			// Persist a single-widget selection (simulates post-Apply from the picker).
			writeFileSync(`${dbPath}.settings.json`, JSON.stringify({ version: 1, dashboardWidgets: ['kpi'] }), 'utf8');

			const server = await startServer(dbPath);
			try {
				const page = await getHtml(server.base, '/');
				expect(page.status).toBe(200);
			// Only the KPI skeleton renders.
			expect(page.body).toContain('Cost &amp; tokens');
			expect(page.body).not.toContain('Sessions per day');
			expect(page.body).not.toContain('Cost per day');
			expect(page.body).not.toContain('Top tools');
			expect(page.body).not.toContain('Agent distribution');
			expect(page.body).not.toContain('Top projects');
			expect(countElementClasses(page.body, 'skeleton-widget')).toBe(1);
			} finally {
				await server.stop();
			}
		}, 60_000);

		test('unknown widget ids in settings are dropped silently, known ones rendered', async () => {
			const dir = tempDir('subagentix-dashboard-mixed-');
			const dbPath = join(dir, 'fixture.db');
			buildPopulatedDb(dbPath);
			// Mix of known and unknown ids — the loader should drop the unknowns.
			writeFileSync(
				`${dbPath}.settings.json`,
				JSON.stringify({ version: 1, dashboardWidgets: ['kpi', 'nonexistent', 'top-tools'] }),
				'utf8'
			);

			const server = await startServer(dbPath);
			try {
				const page = await getHtml(server.base, '/');
				expect(page.status).toBe(200);
				expect(page.body).toContain('Cost &amp; tokens');
				expect(page.body).toContain('Top tools');
				expect(countElementClasses(page.body, 'skeleton-widget')).toBe(2);
			} finally {
				await server.stop();
			}
		}, 60_000);

		test('stored dashboardFilter renders the stored period as selected in SSR', async () => {
			const dir = tempDir('subagentix-dashboard-filter-stored-');
			const dbPath = join(dir, 'fixture.db');
			buildPopulatedDb(dbPath);
			// Persist a stored filter preference (simulates a prior manual selector change).
			writeFileSync(
				`${dbPath}.settings.json`,
				JSON.stringify({ version: 2, dashboardFilter: { period: '30d', scope: null } }),
				'utf8'
			);

			const server = await startServer(dbPath);
			try {
				const page = await getHtml(server.base, '/');
				expect(page.status).toBe(200);
				// The stored 30d period should be selected in the SSR markup.
				expect(page.body).toContain('value="30d"');
				expect(page.body).toContain('value="all"');
				// The selected option should carry the selected attribute.
				expect(page.body).toMatch(/<option value="30d"[^>]*selected/);
			} finally {
				await server.stop();
			}
		}, 60_000);

		test('URL period wins over stored dashboardFilter in SSR', async () => {
			const dir = tempDir('subagentix-dashboard-filter-url-wins-');
			const dbPath = join(dir, 'fixture.db');
			buildPopulatedDb(dbPath);
			// Persist a stored 90d preference.
			writeFileSync(
				`${dbPath}.settings.json`,
				JSON.stringify({ version: 2, dashboardFilter: { period: '90d', scope: null } }),
				'utf8'
			);

			const server = await startServer(dbPath);
			try {
				// URL explicitly asks for 7d — it must win over the stored 90d.
				const page = await getHtml(server.base, '/?period=7d');
				expect(page.status).toBe(200);
				expect(page.body).toContain('value="7d"');
				// The 7d option must be the selected one.
				expect(page.body).toMatch(/<option value="7d"[^>]*selected/);
				// The stored 90d option must NOT be selected.
				expect(page.body).not.toMatch(/<option value="90d"[^>]*selected/);
			} finally {
				await server.stop();
			}
		}, 60_000);

		test('deep-link URL with unknown scope degrades stored scope to all-projects', async () => {
			const dir = tempDir('subagentix-dashboard-filter-scope-degrade-');
			const dbPath = join(dir, 'fixture.db');
			buildPopulatedDb(dbPath);
			writeFileSync(
				`${dbPath}.settings.json`,
				JSON.stringify({ version: 2, dashboardFilter: { period: '7d', scope: '/deleted-dir' } }),
				'utf8'
			);

			const server = await startServer(dbPath);
			try {
				// No explicit scope in URL -> stored scope, but /deleted-dir is unknown so it degrades to all.
				const page = await getHtml(server.base, '/');
				expect(page.status).toBe(200);
				// The stored 7d period is still honoured (it is valid).
				expect(page.body).toMatch(/<option value="7d"[^>]*selected/);
				// Scope degrades to all (null).
				expect(page.body).toMatch(/<option value="all"[^>]*selected/);
			} finally {
				await server.stop();
			}
		}, 60_000);
	});

	describe('SSR turn Gantt against a crafted fixture (M3b)', () => {
	test('/sessions/[id]?turn= renders the skeleton in SSR body and resolves the GanttModel async', async () => {
		const dir = tempDir('subagentix-m3b-gantt-');
		const dbPath = join(dir, 'fixture.db');
		buildGanttDb(dbPath);

		const server = await startServer(dbPath);
		try {
			const page = await getHtml(server.base, '/sessions/root1?turn=u1');
			expect(page.status).toBe(200);
			// Task #385: SSR body carries the shell (header + skeleton), not the Gantt SVG.
			// (The shell itself has icon SVGs, so scope this to the chart canvas.)
			expect(page.body).not.toContain('class="chart');
			expect(page.body).not.toContain('aria-label="Turn wall-clock Gantt"');
			expect(page.body).toContain('gantt-loading');
			// Header card in SSR body is still synchronous.
			expect(page.body).toMatch(/<h1[^>]*>Gantt root<\/h1>/);
			expect(page.body).toContain('class="tokens');
			expect(page.body).toMatch(/class="tokens[^"]*"[\s\S]*?Total<\/span>/);
			expect(page.body).toContain('$3.0000');
			expect(page.body).toMatch(/class="time-range[^"]*"[\s\S]*?[0-9:]+ → [0-9:]+/);

			// Resolve the deferred GanttOutline from the trailing script tag.
			const model = extractDeferredGantt(page.body) as {
				turnId: string;
				triggerMessageId?: string;
				rootSessionId: string;
				nodes: Node[];
				edges: Array<{ id: string }>;
				steps?: unknown[];
				toolCalls?: unknown[];
				markers?: unknown[];
			} | null;
			expect(model).not.toBeNull();
			// Phase 4 (#387): the streamed payload is the lightweight outline — it
			// carries the nodes/edges needed to draw the chart and defers the heavy
			// per-node detail to the lazy node endpoint.
			expect(model!.turnId).toBe('root1_u1');
			expect(model!.triggerMessageId).toBe('u1');
			expect(model!.rootSessionId).toBe('root1');
			expect(model!.steps).toBeUndefined();
			expect(model!.toolCalls).toBeUndefined();
			expect(model!.markers).toBeUndefined();
			// Nodes: root + 4 children = 5, ordered by `orderNodes` (pre-order DFS).
			const ordered = orderNodes(model!.nodes);
			expect(ordered.length).toBe(5);
			expect(ordered[0].sessionId).toBe('root1');
			expect(ordered.map((n) => n.sessionId)).toContain('child1');
			// Edges: 6 edges in the fixture.
			expect(model!.edges.length).toBe(6);

			// The loader's 404 path is also an HTTP 404 page, not a crash.
			const missing = await getHtml(server.base, '/sessions/root1?turn=does-not-exist');
			expect(missing.status).toBe(404);
		} finally {
			await server.stop();
		}
	}, 60_000);
});

describe('SSR #241 — .selected divider removed', () => {
	test('the session page source no longer sets border-top on .selected', () => {
		const page = readFileSync(join(repoRoot, 'src/routes/sessions/[id]/+page.svelte'), 'utf8');
		// The `.selected` block must not contain any `border-top` declaration.
		const selectedBlock = page.match(/\.selected\s*\{[^}]*\}/)?.[0] ?? '';
		expect(selectedBlock).not.toContain('border-top');
		// The comment explaining the removal must be present.
		expect(page).toContain('No divider above the chart (task #241)');
	});
});

		describe('SSR short/long turn time-scale fix (M3b #193, inset #234)', () => {
			test('a 15 s turn fills the fallback chart: the node bar spans the inset band', async () => {
				const dir = tempDir('subagentix-m3b-short-');
				const dbPath = join(dir, 'fixture.db');
				buildShortTurnDb(dbPath);

				const server = await startServer(dbPath);
				try {
					const page = await getHtml(server.base, '/sessions/shortroot?turn=su1');
					expect(page.status).toBe(200);
					// Verify skeleton renders in SSR body.
					expect(page.body).toContain('gantt-loading');

					const model = extractDeferredGantt(page.body) as {
						t0: number;
						t1: number;
						nodes: Node[];
					} | null;
					expect(model).not.toBeNull();
					// Task #224/#193: the span is 15 s, fallback chart width = 720.
					const span = model!.t1 - model!.t0;
					expect(span).toBe(15_000);
					const { chartWidth } = computeTimeScale(span, 0);
					expect(chartWidth).toBe(FALLBACK_CHART_W);

					const ordered = orderNodes(model!.nodes);
					expect(ordered[0].sessionId).toBe('shortroot');
					// The full span maps onto the inset band: bar starts at inset (16) and
					// ends at chartWidth - inset (16), confirming the width-fitted scale.
					expect(ordered[0].startedAt).toBe(model!.t0);
					expect(ordered[0].endedAt).toBe(model!.t1);
				} finally {
					await server.stop();
				}
			}, 60_000);

			test('a 120 s turn is compressed to fit the unmeasured fallback chart (720)', async () => {
				const dir = tempDir('subagentix-m3b-long-');
				const dbPath = join(dir, 'fixture.db');
				buildLongTurnDb(dbPath);

				const server = await startServer(dbPath);
				try {
					const page = await getHtml(server.base, '/sessions/longroot?turn=lu1');
					expect(page.status).toBe(200);
					expect(page.body).toContain('gantt-loading');

					const model = extractDeferredGantt(page.body) as {
						t0: number;
						t1: number;
						nodes: Node[];
					} | null;
					expect(model).not.toBeNull();
					// Task #224: no floor — even a 120 s span fits the same 720 px fallback.
					const span = model!.t1 - model!.t0;
					expect(span).toBe(120_000);
					const { chartWidth } = computeTimeScale(span, 0);
					expect(chartWidth).toBe(FALLBACK_CHART_W);

					const ordered = orderNodes(model!.nodes);
					expect(ordered[0].sessionId).toBe('longroot');
					expect(ordered[0].startedAt).toBe(model!.t0);
					expect(ordered[0].endedAt).toBe(model!.t1);
				} finally {
					await server.stop();
				}
			}, 60_000);

			test('the running bar anchors to the data edge inside the inset band', async () => {
				const dir = tempDir('subagentix-m3b-running-');
				const dbPath = join(dir, 'fixture.db');
				buildRunningTurnDb(dbPath);

				const server = await startServer(dbPath);
				try {
					const page = await getHtml(server.base, '/sessions/runroot?turn=ru1');
					expect(page.status).toBe(200);
					expect(page.body).toContain('gantt-loading');

					const model = extractDeferredGantt(page.body) as {
						t0: number;
						t1: number;
						nodes: Node[];
					} | null;
					expect(model).not.toBeNull();
					// A running turn: extent.end = now (t1 clamped to now by turnExtent).
					const span = model!.t1 - model!.t0;
					expect(span).toBeGreaterThan(0);
					// Fallback chart width is always ≥ 720 for any positive span.
					const { chartWidth } = computeTimeScale(span, 0);
					expect(chartWidth).toBeGreaterThanOrEqual(FALLBACK_CHART_W);

					const ordered = orderNodes(model!.nodes);
					const main = ordered.find((n) => n.sessionId === 'runroot');
					expect(main).toBeDefined();
					// Running node's endedAt is null; extent.end (= t1) equals now, so the
					// bar reaches the right inset band edge — the data edge.
					expect(main!.endedAt).toBeNull();
					expect(main!.startedAt).toBe(model!.t0);
				} finally {
					await server.stop();
				}
			}, 60_000);
	});

describe('SSR empty-state', () => {
	test('/ renders the dashboard shell for a session-less DB and the sidebar its empty state', async () => {
		const dir = tempDir('subagentix-m3a-empty-');
		const dbPath = join(dir, 'empty.db');
		buildEmptyDb(dbPath);

		const server = await startServer(dbPath);
		try {
			const list = await getHtml(server.base, '/');
			expect(list.status).toBe(200);
			// The dashboard shell renders regardless of session data (default selection).
			expect(list.body).toContain('class="dashboard');
			expect(list.body).toContain('class="widget-grid');
			expect(list.body).toContain('class="skeleton-widget');
			// The dashboard main area has no session list/empty-state of its own.
			expect(list.body).not.toContain('No sessions found.');
			// The sidebar shows its own empty state (0 seeds, total 0).
			expect(list.body).toContain('No sessions available.');
		} finally {
			await server.stop();
		}
	}, 60_000);
});

describe('DB-unavailable error page', () => {
	test('the shell renders (200) while /sessions/[id] and APIs return 503', async () => {
		const dir = tempDir('subagentix-m3a-missing-');
		const dbPath = join(dir, 'missing.db');

		const server = await startServer(dbPath);
		try {
			// `/` reads settings.json only (no DB), so the dashboard shell renders with
			// the sidebar's null fallback even when the data layer is unavailable.
			const list = await getHtml(server.base, '/');
			expect(list.status).toBe(200);
			expect(list.body).toContain('class="dashboard');
			expect(list.body).toContain('Session list unavailable.');

			const detail = await getHtml(server.base, '/sessions/root1');
			expect(detail.status).toBe(503);
			expect(detail.body).toContain('opencode database not found');

			const api = await fetch(`${server.base}/api/sessions`);
			expect(api.status).toBe(503);
			const payload = (await api.json()) as { error?: string };
			expect(payload.error).toContain('opencode database not found');

			// The process survived the error path.
			const again = await fetch(`${server.base}/api/sessions`);
			expect(again.status).toBe(503);

			// No mutating-open fallback created the missing DB file.
			expect(existsSync(dbPath)).toBe(false);
		} finally {
			await server.stop();
		}
	}, 60_000);
});

/* ------------------------------------------------------------------ */
/* U1/U2 UI shell (tasks #206 / #207, test task #208)                  */
/* ------------------------------------------------------------------ */

/**
 * The pre-U2 hardcoded hexes found in the component sources at HEAD, plus the
 * blue accents removed in task #215. No `.svelte` file may hardcode any of
 * these; the data-layer `MODEL_PALETTE` is the single accepted exception.
 */
const LEGACY_PALETTE = [
	'#4f8cff',
	'#06b6d4',
	'#164e63',
	'#1d4ed8',
	'#1e3a8a',
	'#22c55e',
	'#4c1d95',
	'#64748b',
	'#78350f',
	'#7f1d1d',
	'#8899aa',
	'#94a3b8',
	'#a5f3fc',
	'#bfdbfe',
	'#ddd6fe',
	'#e6e9ef',
	'#ef4444',
	'#f59e0b',
	'#f87171',
	'#fbbf24',
	'#fca5a5',
	'#fde68a',
	'#fecaca'
];

describe('U1 shell — SSR sidebar (search, seeded list, lazy turns, active URL)', () => {
	test('renders the search input, seeded list, expand affordance and Load more', async () => {
		const dir = tempDir('subagentix-u1-sidebar-');
		const dbPath = join(dir, 'fixture.db');
		buildShellDb(dbPath);

		const server = await startServer(dbPath);
		try {
			const page = await getHtml(server.base, '/');
			expect(page.status).toBe(200);

			// Sidebar landmark + search input.
			expect(page.body).toContain('id="session-sidebar"');
			expect(page.body).toContain('aria-label="Session navigator"');
			expect(page.body).toContain('type="search"');
			expect(page.body).toContain('Search sessions');

			// Seeded first page (30 of 35), newest-first: shell34 in, shell04 out.
			expect(page.body).toContain('Shell 34');
			expect(page.body).toContain('Shell 5');
			expect(page.body.split('aria-controls="turns-shell34"').length - 1).toBe(1);
			expect(page.body.split('aria-controls="turns-shell04"').length - 1).toBe(0);

			// The directory → session → turn tree (task #212): the first directory
			// row is pre-expanded (loader seeds its first page), so its sessions
			// render as collapsed rows below it.
			expect(page.body).toContain('/repo/shell');
			expect(page.body.split('aria-controls="directory-0"').length - 1).toBe(1);
			expect(page.body).toMatch(
				/aria-expanded="true"[^>]*aria-controls="directory-0"|aria-controls="directory-0"[^>]*aria-expanded="true"/
			);
			// Directory session count (35 roots in the fixture).
			expect(page.body).toContain('>35<');

			// Per-session expand affordance (collapsed in SSR).
			expect(page.body).toContain('aria-expanded="false"');

			// Load more because total (35) > page size (30).
			expect(page.body).toContain('Load more');

			// The shell toggle and the brand link are rendered.
			expect(page.body).toContain('aria-controls="session-sidebar"');
			expect(page.body).toContain('href="/"');
		} finally {
			await server.stop();
		}
	}, 60_000);

	test('marks the URL-active session row and no session on /', async () => {
		const dir = tempDir('subagentix-u1-active-');
		const dbPath = join(dir, 'fixture.db');
		buildShellDb(dbPath);

		const server = await startServer(dbPath);
		try {
			// The reworked tree (task #212) renders the active session as a
			// `row row-session … selected` button (the old `.session-item.active`
			// pair was removed). Attribute order and the Svelte hash are ignored.
			const detail = await getHtml(server.base, '/sessions/shell34');
			expect(detail.status).toBe(200);
			expect(countElementClasses(detail.body, 'row-session', 'selected')).toBe(1);
			// The active session row is seeded in the pre-expanded first directory,
			// so its turn container id is also rendered exactly once.
			expect(detail.body.split('aria-controls="turns-shell34"').length - 1).toBe(1);

			const home = await getHtml(server.base, '/');
			expect(countElementClasses(home.body, 'row-session', 'selected')).toBe(0);
		} finally {
			await server.stop();
		}
	}, 60_000);
});

describe('U1/U2 shell — full-width layout, opencode theme, client hygiene', () => {
	test('layout source renders the full-viewport sidebar grid + narrow toggle', () => {
		const layout = readFileSync(join(repoRoot, 'src/routes/+layout.svelte'), 'utf8');
		expect(layout).toContain('grid-template-columns: var(--sidebar-width) minmax(0, 1fr)');
		expect(layout).toContain('min-height: 100dvh');
		expect(layout).toContain('height: 100dvh');
		expect(layout).toContain('@media (max-width: 63.99rem)');
		expect(layout).toContain('ui-btn sidebar-toggle');
		expect(layout).toContain('aria-controls="session-sidebar"');
		expect(layout).toContain('aria-expanded={sidebarOpen}');
		expect(layout).not.toMatch(/max-width:\s*64rem/);
	});

	test('list + session pages are not centered in a max-width container', () => {
		for (const rel of ['src/routes/+page.svelte', 'src/routes/sessions/[id]/+page.svelte']) {
			const source = readFileSync(join(repoRoot, rel), 'utf8');
			expect(`${rel}:${/max-width:\s*64rem/.test(source)}`).toBe(`${rel}:false`);
			expect(`${rel}:${/margin:\s*[^;]*\bauto\b/.test(source)}`).toBe(`${rel}:false`);
		}
	});

	test('built CSS carries the opencode dark tokens and body canvas', () => {
		const css = builtCss();
		expect(css).toContain('--background-base:#101010');
		expect(css).toContain('--border-weak-base:#282828');
		expect(css).toContain('--background-strong:#121212');
		expect(css).toMatch(/--text-strong:#[0-9a-f]{6,8}|--text-strong:rgba\(/i);
		expect(css).toMatch(/body\{background:var\(--background-base\)/);
		// The full-width shell grid + narrow-viewport toggle made it into the build.
		expect(css).toContain('grid-template-columns:var(--sidebar-width) minmax(0, 1fr)');
		expect(css).toContain('min-height:100dvh');
		expect(css).toContain('63.99rem');
		expect(css).toContain('sidebar-toggle');
	});

	test('no component keeps the legacy hardcoded hex palette (model palette excepted)', () => {
		const offenders: string[] = [];
		for (const file of walkFiles(join(repoRoot, 'src'))) {
			if (!file.endsWith('.svelte')) continue;
			const text = readFileSync(file, 'utf8').toLowerCase();
			for (const hex of LEGACY_PALETTE) {
				if (text.includes(hex)) offenders.push(`${file.slice(repoRoot.length)}:${hex}`);
			}
		}
		expect(offenders, 'legacy palette hex survived the U2 restyle').toEqual([]);

		// The one accepted exception: the data-layer `MODEL_PALETTE` is now
		// pastel and blue/cyan-free (tasks #215 / #218). Its exact color contracts
		// live in `src/lib/model/gantt.test.ts`; here we only pin the palette
		// surface (first pastel present, removed blue/cyan accents absent).
		const palette = readFileSync(join(repoRoot, 'src/lib/model/gantt.ts'), 'utf8');
		expect(palette).toContain('MODEL_PALETTE');
		expect(palette).toContain("'#efb99f'");
		expect(palette).not.toContain("'#4f8cff'");
		expect(palette).not.toContain("'#06b6d4'");
	});

	test('shell client sources keep no server-only import and no {@html}', () => {
		for (const rel of [
			'src/lib/components/features/sidebar/SessionSidebar.svelte',
			'src/lib/components/features/settings/SettingsModal.svelte',
			'src/routes/+layout.svelte'
		]) {
			const source = readFileSync(join(repoRoot, rel), 'utf8');
			expect(`${rel}:${/{@html/.test(source)}`).toBe(`${rel}:false`);
			const imports = source
				.split('\n')
				.filter((line) => /^\s*import\b/.test(line))
				.join('\n');
			expect(
				`${rel}:${/\$lib\/server|bun:sqlite|opencode\.db|OPENCODE_DB/.test(imports)}`
			).toBe(`${rel}:false`);
		}
	});

	test('SSR closed-modal: settings button present, no dialog markup', async () => {
		const dir = tempDir('subagentix-settings-ssr-');
		const dbPath = join(dir, 'fixture.db');
		buildShellDb(dbPath);

		const server = await startServer(dbPath);
		try {
			const page = await getHtml(server.base, '/');
			expect(page.status).toBe(200);
			// The gear button lives in SessionSidebar (client component, but SSR renders
			// the button element since it has no client-only logic).
			expect(page.body).toContain('settings-button');
			expect(page.body).toContain('aria-label="Settings"');
			expect(page.body).toContain('aria-haspopup="dialog"');
			// The modal is guarded by `{#if open}` with `open=false` in SSR, so no
			// dialog markup should appear anywhere in the HTML.
			expect(page.body).not.toContain('id="settings-dialog"');
			expect(page.body).not.toContain('role="dialog"');
			expect(page.body).not.toContain('aria-modal');
		} finally {
			await server.stop();
		}
	}, 60_000);

	test('SessionSidebar builds turn links, active-turn highlight and lazy fetch (source)', () => {
		const source = readFileSync(join(repoRoot, 'src/lib/components/features/sidebar/SessionSidebar.svelte'), 'utf8');
		expect(source).toContain('?turn=${encodeURIComponent(turn.turnId)}');
		expect(source).toContain('turn.turnId === activeTurnId');
		expect(source).toContain("searchParams.get('turn')");
		expect(source).toContain('fetch(`/api/sessions/${encodeURIComponent(id)}/turns`)');
		expect(source).toContain('toggleSession');
		// All four list states (loading is client-only, so it is source-asserted).
		for (const state of [
			'Loading sessions…',
			'No sessions available.',
			'No matching sessions.',
			'Session list unavailable.'
		]) {
			expect(source).toContain(state);
		}
	});
});

describe('U1 nav indicator (task #384 / #389) — source, built CSS, SSR', () => {
	test('layout source carries role=status, sr-only label, navigating guard, pointer-events:none', () => {
		const layout = readFileSync(join(repoRoot, 'src/routes/+layout.svelte'), 'utf8');
		expect(layout).toContain('role="status"');
		expect(layout).toContain('class="sr-only"');
		expect(layout).toContain('Loading…');
		expect(layout).toContain('navigating.to !== null');
		expect(layout).toContain('pointer-events: none');
	});

	test('built CSS carries .nav-progress fixed + pointer-events:none + animation', () => {
		const css = builtCss();
		const rules = classRules(css, 'nav-progress');
		expect(rules.length).toBeGreaterThan(0);
		const positionRule = rules.find(([, body]) => /position\s*:\s*fixed/.test(body));
		expect(positionRule).toBeDefined();
		const peRule = rules.find(([, body]) => /pointer-events\s*:\s*none/.test(body));
		expect(peRule).toBeDefined();
		// The minifier collapses animation into a single-line shorthand; match anywhere in CSS.
		expect(css).toMatch(/animation\s*:\s*1\.1s/);
	});

	test('built CSS carries prefers-reduced-motion rule for .nav-progress__bar', () => {
		const css = builtCss();
		const rules = classRules(css, 'nav-progress__bar');
		expect(rules.length).toBeGreaterThan(0);
		// The source uses @media (prefers-reduced-motion: reduce); the minifier may
		// inline the query or prefix it. Look for either form in the built output.
		const reducedMotionMatch = css.match(/@media[^{]*prefers-reduced-motion[^{]*\{[^}]*\.nav-progress__bar[^}]*\}/s);
		expect(reducedMotionMatch).not.toBeNull();
		const body = reducedMotionMatch![0];
		// Inside the media block, animation must be disabled and width forced to 100%.
		expect(body).toMatch(/animation\s*:\s*none/);
		expect(body).toMatch(/width\s*:\s*100%/);
	});

	test('SSR does not emit nav-progress (navigating.to is null on the server)', async () => {
		const dir = tempDir('subagentix-nav-indicator-');
		const dbPath = join(dir, 'fixture.db');
		buildShellDb(dbPath);

		const server = await startServer(dbPath);
		try {
			const page = await getHtml(server.base, '/');
			expect(page.status).toBe(200);
			// The nav-progress div is gated on `navigatingActive` ($derived(navigating.to !== null)).
			// On the server navigating.to is always null, so no nav-progress markup should appear.
			expect(page.body).not.toContain('class="nav-progress"');
			expect(page.body).not.toContain('nav-progress__bar');
			// The role=status span must also be absent (it lives inside nav-progress).
			expect(page.body).not.toContain('role="status"');
		} finally {
			await server.stop();
		}
	}, 60_000);
});

/* ------------------------------------------------------------------ */
/* UI review fixes (task #210, test task #211)                         */
/* ------------------------------------------------------------------ */

/** `[selector, declaration body]` pairs for every flat rule in `css`. */
function cssRulePairs(css: string): Array<[string, string]> {
	return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => [
		match[1].trim().replace(/\s+/g, ' '),
		match[2].trim().replace(/\s+/g, ' ')
	]);
}

/** Built CSS rules whose selector contains `.<className>` as a whole class token. */
function classRules(css: string, className: string): Array<[string, string]> {
	const token = new RegExp(`\\.${className}(?![\\w-])`);
	return cssRulePairs(css).filter(([selector]) => token.test(selector));
}

/**
 * Body of a top-level `async function NAME(` by brace matching. Used to scope
 * the search-race source assertions to the exact function (a bare
 * `source.includes` would also match an unrelated helper).
 */
function functionBody(source: string, name: string): string {
	const start = source.indexOf(`async function ${name}(`);
	if (start < 0) throw new Error(`async function ${name} not found`);
	const open = source.indexOf('{', start);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) return source.slice(open + 1, i);
		}
	}
	throw new Error(`unbalanced braces for ${name}`);
}

describe('UI #210/#225 — scroll ownership in the built CSS', () => {
	// The shell `.content` only clamps its column; the inner ScrollView viewport
	// owns the vertical scroll (and its overlay thumb), so `position: sticky`
	// resolves against a real scrollport and `overflow-x` stays unset.
	test('.content clamps its column and never sets overflow-x', () => {
		const rules = classRules(builtCss(), 'content');
		expect(rules.length).toBeGreaterThan(0);
		for (const [selector, body] of rules) {
			expect(`${selector}:${/overflow-x/.test(body)}`).toBe(`${selector}:false`);
		}
		expect(rules.some(([, body]) => /overflow:hidden/.test(body))).toBe(true);
	});

	test('the Gantt .scroll frame no longer scrolls horizontally', () => {
		const rules = classRules(builtCss(), 'scroll');
		expect(rules.length).toBeGreaterThan(0);
		expect(rules.some(([, body]) => /overflow:hidden/.test(body))).toBe(true);
		expect(rules.some(([, body]) => /overflow-x:auto/.test(body))).toBe(false);
	});

	test('the ScrollView viewport hides the native bar and owns the axis scroll', () => {
		const css = builtCss();
		const viewport = classRules(css, 'scroll-view__viewport');
		expect(viewport.length).toBeGreaterThan(0);
		expect(viewport.some(([, body]) => /scrollbar-width:none/.test(body))).toBe(true);
		expect(css).toMatch(/webkit-scrollbar[^{]*\{[^}]*display:\s*none/);
		// The vertical viewport owns the y-scroll; the horizontal one the x-scroll.
		// The minifier may collapse `overflow-x/y` into the `overflow` shorthand.
		expect(
			classRules(css, 'scroll-view__viewport--vertical').some(([, body]) =>
				/(?:overflow:hidden auto|overflow-y:auto)/.test(body)
			)
		).toBe(true);
		expect(
			classRules(css, 'scroll-view__viewport--horizontal').some(([, body]) =>
				/(?:overflow:auto hidden|overflow-x:auto)/.test(body)
			)
		).toBe(true);
		expect(
			classRules(css, 'scroll-view__viewport--both').some(([, body]) =>
				/(?:^|;)overflow:auto(?:;|$)/.test(body)
			)
		).toBe(true);
	});

	test('the ScrollView thumb is neutral — no blue/cyan value in any scrollbar rule', () => {
		const css = builtCss();
		const thumbs = classRules(css, 'scroll-view__thumb');
		expect(thumbs.some(([, body]) => /var\(--border-weak-base\)/.test(body))).toBe(true);
		expect(thumbs.some(([, body]) => /var\(--border-strong-base\)/.test(body))).toBe(true);
		// Scan every built rule whose selector mentions the scroll view; none may
		// introduce a blue/cyan color (the app tokens keep `--blue-dark-*` around).
		const scrollRules = cssRulePairs(css).filter(([selector]) => /scroll-view/.test(selector));
		expect(scrollRules.length).toBeGreaterThan(0);
		const forbidden = /#(?:4f8cff|06b6d4|0091ff|389eff|51a8ff)|--blue/;
		for (const [selector, body] of scrollRules) {
			expect(`${selector}:${forbidden.test(body)}`).toBe(`${selector}:false`);
		}
	});
});

describe('UI #215 — inspector below the chart + first-node auto-open', () => {
	const gantt = readFileSync(join(repoRoot, 'src/lib/components/features/gantt/Gantt.svelte'), 'utf8');

	test('the node inspector markup renders below the chart (source)', () => {
		const mainCol = gantt.indexOf('<div class="main-col">');
		const aside = gantt.indexOf('class="side-col"');
		expect(mainCol).toBeGreaterThan(-1);
		expect(aside).toBeGreaterThan(mainCol);
		// The old two-column `with-inspector` layout was removed in task #215.
		expect(gantt).not.toContain('with-inspector');
	});

	test('the built layout CSS is a single column and the side-col is not sticky', () => {
		const layout = classRules(builtCss(), 'layout');
		expect(layout.length).toBeGreaterThan(0);
		expect(
			layout.some(([, body]) => /grid-template-columns:minmax\(0,\s*1fr\)/.test(body))
		).toBe(true);
		expect(layout.some(([selector]) => /with-inspector/.test(selector))).toBe(false);
		// Full-width block below the chart, not a sticky side rail.
		expect(
			classRules(builtCss(), 'side-col').some(([, body]) => /position:sticky/.test(body))
		).toBe(false);
	});

	test('the first node is auto-selected on the client only when the model changes (source)', () => {
		expect(gantt).toContain('let lastAutoOpenedModel: GanttOutline | null = null;');
		// Guarded by the model identity so closing the inspector is not undone
		// until a new model loads; `$effect` is client-only, so SSR stays collapsed.
		expect(gantt).toMatch(
			/\$effect\(\(\) => \{[\s\S]*?if \(model === lastAutoOpenedModel\) return;[\s\S]*?selectedNodeId = rows\[0\]\?\.sessionId \?\? null;/
		);
	});
});

describe('UI #210 — closed-sidebar focus safety', () => {
	test('closed off-canvas panel is visibility:hidden; open state turns it visible (built CSS)', () => {
		const rules = classRules(builtCss(), 'sidebar-slot');
		// Narrow-viewport base: fixed off-canvas overlay, hidden from the tab order.
		const hidden = rules.find(([, body]) => /visibility:hidden/.test(body));
		expect(hidden).toBeDefined();
		expect(hidden![1]).toContain('position:fixed');
		expect(hidden![1]).toContain('translate(-100%)');
		// `.shell.sidebar-open` re-enables visibility (not just the transform).
		const open = rules.filter(([selector]) => /sidebar-open/.test(selector));
		expect(open.length).toBeGreaterThan(0);
		expect(open.some(([, body]) => /visibility:visible/.test(body))).toBe(true);
	});

	test('toggle carries aria-expanded/aria-controls and open/close move focus (source)', () => {
		const layout = readFileSync(join(repoRoot, 'src/routes/+layout.svelte'), 'utf8');
		expect(layout).toContain('aria-expanded={sidebarOpen}');
		expect(layout).toContain('aria-controls="session-sidebar"');
		expect(layout).toContain('bind:this={sidebarSlot}');
		expect(layout).toContain('bind:this={toggleButton}');
		// Opening focuses the first focusable element inside the panel.
		expect(layout).toMatch(/if \(open && !wasOpen\)[\s\S]*?\.focus\(\);/);
		// Closing restores focus to the toggle that opened it.
		expect(layout).toMatch(/else if \(!open && wasOpen\)[\s\S]*?toggleButton\?\.focus\(\);/);
		// Focus management only runs on the same narrow breakpoint as the CSS.
		expect(layout).toContain("window.matchMedia('(max-width: 63.99rem)')");
	});

	test('SSR renders the collapsed toggle with aria-expanded="false" + aria-controls', async () => {
		const dir = tempDir('subagentix-u210-sidebar-');
		const dbPath = join(dir, 'fixture.db');
		buildShellDb(dbPath);

		const server = await startServer(dbPath);
		try {
			const page = await getHtml(server.base, '/');
			expect(page.status).toBe(200);
			expect(page.body).toMatch(
				/class="[^"]*sidebar-toggle[^"]*"[^>]*aria-expanded="false"[^>]*aria-controls="session-sidebar"/
			);
		} finally {
			await server.stop();
		}
	}, 60_000);

	test('no client .svelte surface uses {@html} or imports a server-only module', () => {
		const offenders: string[] = [];
		for (const file of walkFiles(join(repoRoot, 'src'))) {
			if (!file.endsWith('.svelte')) continue;
			const source = readFileSync(file, 'utf8');
			const rel = file.slice(repoRoot.length);
			if (/{@html/.test(source)) offenders.push(`${rel}:@html`);
			const imports = source
				.split('\n')
				.filter((line) => /^\s*import\b/.test(line))
				.join('\n');
			if (/\$lib\/server|bun:sqlite|opencode\.db|OPENCODE_DB/.test(imports)) {
				offenders.push(`${rel}:server-import`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe('UI #210 — Gantt selection vs hover', () => {
	const gantt = readFileSync(join(repoRoot, 'src/lib/components/features/gantt/Gantt.svelte'), 'utf8');
	// Task #276: the turn header (and its summary) moved to GanttHeader.svelte.
	const ganttHeader = readFileSync(join(repoRoot, 'src/lib/components/features/gantt/GanttHeader.svelte'), 'utf8');
	// Task #279: the label button moved to GanttLabelRow.svelte.
	const ganttLabelRow = readFileSync(
		join(repoRoot, 'src/lib/components/features/gantt/GanttLabelRow.svelte'),
		'utf8'
	);
	// Task #280: the SVG row background (its `class:active` hook) moved to
	// GanttChart.svelte.
	const ganttChart = readFileSync(join(repoRoot, 'src/lib/components/features/gantt/GanttChart.svelte'), 'utf8');
	// Task #282: the SVG node group (the other `aria-pressed`/`class:active`
	// surface) moved to GanttNodeRow.svelte.
	const ganttNodeRow = readFileSync(
		join(repoRoot, 'src/lib/components/features/gantt/GanttNodeRow.svelte'),
		'utf8'
	);

	// Task #237: no h3 title; summary starts with time range, not node/edge counts.
	test('no <h3>Turn Gantt</h3> and summary has no count prefixes (source)', () => {
		expect(ganttHeader).not.toContain('<h3>');
		expect(ganttHeader).not.toContain('Turn Gantt');
		expect(ganttHeader).toContain('{formatClock(extent.start, clock.tz)} → {formatClock(extent.end, clock.tz)}');
		expect(ganttHeader).not.toMatch(/node.*count|delegation.*edge.*count/i);
	});

	test('aria-pressed/selected derives from selectedNodeId only, never hover (source)', () => {
		expect(gantt).toContain('let selectedNodeId = $state<string | null>(null);');
		expect(gantt).toContain('let hoveredNodeId = $state<string | null>(null);');
		expect(gantt).toContain('const activeNodeId = $derived(hoveredNodeId ?? selectedNodeId);');
		// The pressed/selected flag is selection-only; hover feeds only `activeNodeId`
		// (dimming + edge emphasis), which must not reach `row.active`.
		expect(gantt).toContain('active: selectedNodeId === node.sessionId,');
		expect(gantt).not.toContain('active: active === node.sessionId,');
		// The label button (in GanttLabelRow) and the SVG node group (in
		// GanttNodeRow, task #282) bind the selection-only flag.
		expect(
			(ganttLabelRow + ganttNodeRow).match(/aria-pressed=\{row\.active\}/g)?.length ?? 0
		).toBeGreaterThanOrEqual(2);
		// The `class:active` styling hook is still present on both surfaces
		// (SVG row-bg in GanttChart + node group in GanttNodeRow). Task #280 moved
		// the row background to GanttChart; task #282 moved the node group to
		// GanttNodeRow.
		expect(
			((ganttChart + ganttNodeRow).match(/class:active=\{row\.active\}/g)?.length ?? 0)
		).toBeGreaterThanOrEqual(2);
		expect(ganttLabelRow.match(/class:active=\{row\.active\}/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
	});

	test('SSR renders no pressed node before any selection (hover cannot set it)', async () => {
		const dir = tempDir('subagentix-u210-gantt-');
		const dbPath = join(dir, 'fixture.db');
		buildGanttDb(dbPath);

		const server = await startServer(dbPath);
		try {
			const page = await getHtml(server.base, '/sessions/root1?turn=u1');
			expect(page.status).toBe(200);
			// Task #385: SSR body has the skeleton, not the Gantt component.
			expect(page.body).toContain('gantt-loading');
			expect(page.body).not.toContain('aria-label="Turn wall-clock Gantt"');
			// No Gantt → no aria-pressed at all (selection only happens post-hydration
			// when the `$effect` sets `selectedNodeId = rows[0]?.sessionId`).
			expect(page.body).not.toContain('aria-pressed="true"');
			// The deferred model resolves with the full GanttModel; its root session
			// and node list are present so the client can auto-select the top row.
			const model = extractDeferredGantt(page.body) as {
				rootSessionId: string;
				nodes: Node[];
			} | null;
			expect(model).not.toBeNull();
			expect(model!.rootSessionId).toBe('root1');
			expect(orderNodes(model!.nodes).length).toBe(5);
		} finally {
			await server.stop();
		}
	}, 60_000);
});

describe('UI #210 — dark running hatch', () => {
	test('running hatch + legend share a dark amber color-mix, not the light warning token (source)', () => {
		const gantt = readFileSync(join(repoRoot, 'src/lib/components/features/gantt/Gantt.svelte'), 'utf8');
		// Task #277: the legend markup and CSS moved to GanttLegend.svelte; the
		// `--running-hatch-bg` declaration stays on the `.gantt` root in Gantt.
		// Task #280: the SVG hatch pattern CSS moved to GanttChart.svelte.
		const ganttChart = readFileSync(join(repoRoot, 'src/lib/components/features/gantt/GanttChart.svelte'), 'utf8');
		const ganttLegend = readFileSync(
			join(repoRoot, 'src/lib/components/features/gantt/GanttLegend.svelte'),
			'utf8'
		);
		// The light warning token may be mentioned in the explanatory comment;
		// what matters is that no declaration consumes it.
		expect(gantt).not.toContain('var(--surface-warning-weak)');
		expect(ganttChart).not.toContain('var(--surface-warning-weak)');
		expect(gantt).toMatch(
			/--running-hatch-bg:\s*color-mix\(in srgb, var\(--color-warning-base\) 25%, var\(--background-strong\)\)/
		);
		// The SVG pattern background uses the shared dark token.
		expect(ganttChart).toContain('fill: var(--running-hatch-bg)');
		expect(ganttChart).toContain('stroke: var(--color-warning-base)');
		// The legend chip is the same hatch, not a second light colour.
		expect(ganttLegend).toContain('<span class="running-chip"></span>');
		expect(ganttLegend).toMatch(
			/\.running-chip \{[\s\S]*?var\(--running-hatch-bg\)[\s\S]*?var\(--color-warning-base\)/
		);
		expect(ganttLegend).not.toMatch(/\.running-chip \{[\s\S]*?surface-warning-weak/);
	});

	test('built Gantt CSS keeps the dark running hatch token (no surface-warning-weak)', () => {
		const css = builtCss();
		expect(css).toMatch(
			/--running-hatch-bg:\s*color-mix\(in srgb, var\(--color-warning-base\) 25%, var\(--background-strong\)\)/
		);
		// The Gantt's own rules never fall back to the near-white warning surface.
		expect(css).not.toMatch(/\.hatch-running-bg[^{]*\{[^}]*surface-warning-weak/);
		expect(css).not.toMatch(/\.running-chip[^{]*\{[^}]*surface-warning-weak/);
		// Legend chip consumes the same dark hatch token.
		expect(css).toMatch(/\.running-chip[^{]*\{[^}]*var\(--running-hatch-bg\)/);
	});
});

describe('UI #212 — sidebar request race guards (SessionSidebar source)', () => {
	// Limitation: the guards live inside a client-only Svelte component with no
	// DOM runtime in `bun test`, so these are scoped static assertions rather
	// than executed interleavings. They are falsifiable: removing a guard, the
	// sequence bump or the catch-branch list reset fails them.
	const source = readFileSync(join(repoRoot, 'src/lib/components/features/sidebar/SessionSidebar.svelte'), 'utf8');

	test('flat search takes a monotonic searchSeq and superseded responses bail out', () => {
		// Task #212 split the old single `requestSeq` into `searchSeq` (flat
		// search) and a per-node `requestSeq` Map (directory/session loads).
		expect(source).toContain('let searchSeq = 0;');
		for (const name of ['runSearch', 'loadMoreSearch']) {
			const body = functionBody(source, name);
			// Bump before awaiting, so the newest request owns the highest seq.
			const bump = body.indexOf('const seq = ++searchSeq;');
			expect(bump).toBeGreaterThan(-1);
			expect(bump).toBeLessThan(body.indexOf('await'));
			// A stale success and a stale failure both return without mutating.
			expect(body.match(/if \(seq !== searchSeq\) return;/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
			// `searchLoading` is only cleared by the still-current request.
			expect(body).toContain('if (seq === searchSeq) searchLoading = false;');
		}
	});

	test('an error clears the stale search results instead of showing them next to the error', () => {
		for (const name of ['runSearch', 'loadMoreSearch']) {
			const body = functionBody(source, name);
			const catchIndex = body.indexOf('} catch');
			expect(catchIndex).toBeGreaterThan(-1);
			const catchBody = body.slice(catchIndex);
			// Stale errors are dropped before they touch state...
			expect(catchBody.indexOf('if (seq !== searchSeq) return;')).toBeLessThan(
				catchBody.indexOf('searchError =')
			);
			// ...and a current error clears the list instead of leaving it stale.
			expect(catchBody).toContain('searchResults = [];');
			expect(catchBody).toContain('searchHasMore = false;');
		}
	});

	test('per-node lazy loads use a per-key requestSeq Map (nodes never cancel each other)', () => {
		expect(source).toContain('const requestSeq = new Map<string, number>();');
		expect(source).toContain('function nextRequestSeq(key: string): number {');
		for (const [name, keyExpr] of [
			['loadDirectory', 'dir:${directory}'],
			['loadTurns', 'turns:${id}']
		] as const) {
			const body = functionBody(source, name);
			// Each node gets its own seq under a node-scoped key...
			expect(body).toContain(`const key = \`${keyExpr}\`;`);
			expect(body).toContain('const seq = nextRequestSeq(key);');
			// ...so a stale success/failure for the same node bails out while an
			// unrelated node's in-flight load is untouched.
			expect(body.match(/requestSeq\.get\(key\) !== seq/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
			expect(body).toContain('requestSeq.get(key) === seq');
		}
	});
});

/* ------------------------------------------------------------------ */
/* Deep-link tool-call overlay (task #484)                              */
/* ------------------------------------------------------------------ */

describe('tool-call overlay deep links (task #481/#484)', () => {
	test('?toolErrors=<tool> resolves to mode errors', () => {
		const source = readFileSync(join(repoRoot, 'src/routes/+page.svelte'), 'utf8');
		// The readToolDetail function must check TOOL_ERRORS_PARAM first and return mode 'errors'.
		expect(source).toContain("const errorsTool = search.get(TOOL_ERRORS_PARAM);");
		expect(source).toContain("if (errorsTool !== null && errorsTool !== '') return { tool: errorsTool, mode: 'errors' };");
	});

	test('?toolCalls=<tool> resolves to mode all', () => {
		const source = readFileSync(join(repoRoot, 'src/routes/+page.svelte'), 'utf8');
		// The readToolDetail function must check TOOL_CALLS_PARAM and return mode 'all'.
		expect(source).toContain("const callsTool = search.get(TOOL_CALLS_PARAM);");
		expect(source).toContain("if (callsTool !== null && callsTool !== '') return { tool: callsTool, mode: 'all' };");
	});

	test('?toolErrors= wins over ?toolCalls= when both are present', () => {
		const source = readFileSync(join(repoRoot, 'src/routes/+page.svelte'), 'utf8');
		// errors is checked first, so it wins.
		const errorsIndex = source.indexOf("search.get(TOOL_ERRORS_PARAM)");
		const callsIndex = source.indexOf("search.get(TOOL_CALLS_PARAM)");
		expect(errorsIndex).toBeGreaterThan(-1);
		expect(callsIndex).toBeGreaterThan(-1);
		expect(errorsIndex).toBeLessThan(callsIndex);
	});

	test('overlayUrl maps mode to the correct param name', () => {
		const source = readFileSync(join(repoRoot, 'src/routes/+page.svelte'), 'utf8');
		// The overlayUrl function must set toolErrors for errors mode and toolCalls for all mode.
		expect(source).toContain("detail.mode === 'errors' ? TOOL_ERRORS_PARAM : TOOL_CALLS_PARAM");
	});

	test('popstate handler re-seeds toolDetail from the URL', () => {
		const source = readFileSync(join(repoRoot, 'src/routes/+page.svelte'), 'utf8');
		// Browser Back/Forward must restore the overlay from the address bar.
		expect(source).toContain('window.addEventListener(\'popstate\', sync)');
		expect(source).toContain('readToolDetail(new URL(location.href).searchParams)');
	});
});
