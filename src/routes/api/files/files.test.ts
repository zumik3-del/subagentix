import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the files API route suite (task #780, epic #775).
 *
 * The suite opens a real fixture DB and sets `OPENCODE_DB` /
 * `OPENCODE_CONFIG_DIR`, so it runs in an isolated child `bun test` process
 * to avoid polluting the parent runner's module graph.
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const suite = './src/routes/api/files/files.suite.ts';

test('files API route suite passes in an isolated child process', async () => {
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
