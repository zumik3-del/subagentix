import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the tool-errors route regression suite (task #481).
 *
 * Exercises `GET /api/dashboard/tool-errors` against a fixture DB in an
 * isolated child `bun test` process so the SvelteKit module graph stays clean.
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const suite = './src/routes/api/dashboard/tool-errors.suite.ts';

test('tool-errors route suite passes in an isolated child process', async () => {
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
}, 30_000);
