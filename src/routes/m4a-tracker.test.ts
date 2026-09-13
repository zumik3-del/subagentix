import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the M4a ziptask-link render suite (task #199).
 *
 * The suite loads the client `Gantt` component through Vite's SSR module runner
 * and renders it with `svelte/server`; it runs in an isolated child `bun test`
 * process so the Vite server and its module graph stay out of the parent run
 * (pattern from `m3c-drilldown.test.ts`).
 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const suite = './src/routes/m4a-tracker.suite.ts';

test('M4a tracker render suite passes in an isolated child process', async () => {
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
}, 120_000);
