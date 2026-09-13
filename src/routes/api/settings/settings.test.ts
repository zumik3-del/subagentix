import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * Wrapper for the settings API suite (task #257).
 *
 * The suite exercises real route handlers that depend on `$lib/server/db` and
 * `$lib/server/settings` with global mutable state, so it runs in an isolated
 * child `bun test` process to avoid polluting the parent test runner's module
 * graph.
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const suite = './src/routes/api/settings/settings.suite.ts';

test('settings API suite passes in an isolated child process', async () => {
	// Inherit the parent env but explicitly clear any SETTINGS_FILE / OPENCODE_DB
	// that a sibling test file may have planted. The suite sets its own isolated
	// path at module-load time.
	const cleanEnv = { ...process.env };
	delete cleanEnv.SETTINGS_FILE;
	delete cleanEnv.OPENCODE_DB;
	delete cleanEnv.ZIPTASK_BASE_URL;
	delete cleanEnv.OPENCODE_AGENTS_DIR;
	delete cleanEnv.STATE_DIRECTORY;

	const proc = Bun.spawn(['bun', 'test', suite], {
		cwd: repoRoot,
		env: cleanEnv,
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
});
