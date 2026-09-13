import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the `GET /api/tracker/task/:id` proxy suite.
 *
 * The suite imports the real `$lib/server/settings` module and points
 * `SETTINGS_FILE`/`ZIPTASK_BASE_URL` at fixtures, so it runs in an isolated
 * child `bun test` process to keep that env/module state out of the parent run
 * (pattern from `m4a-tracker.test.ts`).
 */
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const suite = './src/routes/api/tracker/task/tracker-task.suite.ts';

test('tracker task proxy suite passes in an isolated child process', async () => {
	const proc = Bun.spawn(['bun', 'test', suite], {
		cwd: repoRoot,
		env: process.env,
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	]);
	const report = `${stdout}\n${stderr}`;
	if (exitCode !== 0) console.error(report);

	expect(report).toContain('0 fail');
	expect(report).toMatch(/[1-9]\d* pass/);
	expect(exitCode).toBe(0);
}, 60_000);
