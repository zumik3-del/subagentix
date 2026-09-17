/**
 * SSR render suite for SettingsModal (task #257; header-X / actions-only footer #501).
 *
 * Pins the rendered structure of SettingsModal via Vite's SSR module runner.
 * No DOM runtime, no DB.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type ViteDevServer } from 'vite';

type RenderFn = (
	component: unknown,
	options: { props: Record<string, unknown> }
) => { body: string };

let vite: ViteDevServer;
let render: RenderFn;
let SettingsModal: unknown;

beforeAll(async () => {
	vite = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'error'
	});
	render = ((await vite.ssrLoadModule('svelte/server')) as { render: RenderFn }).render;

	SettingsModal = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/settings/SettingsModal.svelte'
		)) as { default: unknown }
	).default;
}, 60_000);

afterAll(async () => {
	await vite?.close();
});

// --- SettingsModal SSR --------------------------------------------------------

describe('SettingsModal SSR', () => {
	const baseProps = {
		open: true,
		onClose: () => {}
	};

	test('closed dialog (open=false) emits no dialog markup at all', () => {
		const html = render(SettingsModal, { props: { ...baseProps, open: false } }).body;
		expect(html).not.toContain('role="dialog"');
		expect(html).not.toContain('aria-modal');
		expect(html).not.toContain('settings-dialog');
	});

	test('opened dialog carries role=dialog, aria-modal and labelled-by', () => {
		const html = render(SettingsModal, { props: baseProps }).body;
		expect(html).toContain('role="dialog"');
		expect(html).toContain('aria-modal="true"');
		expect(html).toContain('aria-labelledby="settings-title"');
		expect(html).toContain('>Settings<');
	});

	test('header has the icon close control with settings-specific aria-label and no footer Close/Cancel', () => {
		const html = render(SettingsModal, { props: baseProps }).body;
		expect(html).toContain('ui-icon-btn');
		expect(html).toContain('aria-label="Close settings"');
		expect(html).not.toContain('>Close<');
		expect(html).not.toContain('>Cancel<');
	});

	test('footer carries Save (primary action last) with no Cancel', () => {
		const html = render(SettingsModal, { props: baseProps }).body;
		expect(html).toContain('ui-modal__foot');
		expect(html).toContain('>Save<');
		expect(html).not.toContain('>Cancel<');
	});

	test('header is a single row: title + close in one .ui-modal__head', () => {
		const html = render(SettingsModal, { props: baseProps }).body;
		expect(html).toContain('ui-modal__head');
		expect(html).toContain('ui-modal__title');
		expect(html.match(/<h2[^>]*>/g)?.length ?? 0).toBe(1);
	});
});
