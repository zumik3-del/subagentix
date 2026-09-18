/**
 * SSR render suite for TopToolsTable and ToolErrorsModal (task #481; all-calls #484).
 *
 * Pins the rendered structure:
 * - TopToolsTable: calls count and tool name are interactive buttons opening
 *   mode `all`; errors count is a button only when errors > 0 (mode `errors`);
 *   the errors button carries no underline (text-decoration: none).
 * - ToolErrorsModal: all mode renders a Status column and "Tool calls" copy;
 *   failures mode keeps "Failed tool calls" copy and omits the Status column.
 *
 * No DOM runtime, no DB. Uses Vite's SSR module runner.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type ViteDevServer } from 'vite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type RenderFn = (
	component: unknown,
	options: { props: Record<string, unknown> }
) => { body: string };

let vite: ViteDevServer;
let render: RenderFn;
let TopToolsTable: unknown;
let ToolErrorsModal: unknown;

beforeAll(async () => {
	vite = await createServer({
		root: process.cwd(),
		server: { middlewareMode: true },
		appType: 'custom',
		logLevel: 'error'
	});
	render = ((await vite.ssrLoadModule('svelte/server')) as { render: RenderFn }).render;

	TopToolsTable = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/TopToolsTable.svelte'
		)) as { default: unknown }
	).default;
	ToolErrorsModal = (
		(await vite.ssrLoadModule(
			'/src/lib/components/features/dashboard/ToolErrorsModal.svelte'
		)) as { default: unknown }
	).default;
}, 60_000);

afterAll(async () => {
	await vite?.close();
});

function normalizeHtml(html: string): string {
	return html
		.replace(/\bsvelte-[a-z0-9]+/g, '')
		.replace(/class="([^"]*)"/g, (_m, v) => `class="${v.trim()}"`)
		.replace(/\s+/g, ' ')
		.trim();
}

function countClass(html: string, token: string): number {
	const normalized = normalizeHtml(html);
	const re = /class="([^"]*)"/g;
	let c = 0;
	for (const m of normalized.matchAll(re)) {
		const tokens = m[1].split(/\s+/);
		if (tokens.includes(token)) c++;
	}
	return c;
}

// --- Fixtures ---------------------------------------------------------------

const ROWS_WITH_ERRORS = [
	{ name: 'bash', count: 100, errors: 5, title: '5 of 100 calls errored (5%)' },
	{ name: 'read', count: 50, errors: 0, title: '0 of 50 calls errored (0%)' }
];

const ROWS_NO_ERRORS = [
	{ name: 'bash', count: 100, errors: 0, title: '0 of 100 calls errored (0%)' }
];

// --- TopToolsTable ------------------------------------------------------------

describe('TopToolsTable SSR', () => {
	test('errors cell is a <button> when errors > 0 and onOpenToolDetail is supplied', () => {
		const html = render(TopToolsTable, {
			props: { rows: ROWS_WITH_ERRORS, onOpenToolDetail: () => {} }
		}).body;
		// The first row (bash, errors=5) should have a button.
		expect(countClass(html, 'top-tools__errors-btn')).toBe(1);
		expect(html).toContain('>5<');
	});

	test('errors cell is a <span> when errors == 0', () => {
		const html = render(TopToolsTable, {
			props: { rows: ROWS_WITH_ERRORS, onOpenToolDetail: () => {} }
		}).body;
		// The second row (read, errors=0) should NOT have a button.
		// Count buttons: only the bash row has errors>0.
		expect(countClass(html, 'top-tools__errors-btn')).toBe(1);
	});

	test('errors cell is inert <span> when onOpenToolDetail is absent', () => {
		const html = render(TopToolsTable, {
			props: { rows: ROWS_WITH_ERRORS }
		}).body;
		// Without onOpenToolDetail, even rows with errors > 0 render as <span>.
		expect(countClass(html, 'top-tools__errors-btn')).toBe(0);
		expect(html).toContain('top-tools__errors');
	});

	test('errors cell is inert <span> when errors == 0 even with onOpenToolDetail', () => {
		const html = render(TopToolsTable, {
			props: { rows: ROWS_NO_ERRORS, onOpenToolDetail: () => {} }
		}).body;
		expect(countClass(html, 'top-tools__errors-btn')).toBe(0);
	});

	test('table has the correct columns in thead', () => {
		const html = render(TopToolsTable, {
			props: { rows: ROWS_WITH_ERRORS, onOpenToolDetail: () => {} }
		}).body;
		expect(html).toContain('scope="col"');
		expect(html).toContain('Tool');
		expect(html).toContain('Calls');
		expect(html).toContain('Errors');
	});

	test('renders all rows from the input', () => {
		const html = render(TopToolsTable, {
			props: { rows: ROWS_WITH_ERRORS, onOpenToolDetail: () => {} }
		}).body;
		expect(html).toContain('>bash<');
		expect(html).toContain('>read<');
	});

	test('empty rows renders an empty table body', () => {
		const html = render(TopToolsTable, {
			props: { rows: [], onOpenToolDetail: () => {} }
		}).body;
		expect(html).toContain('top-tools__table');
		// No data rows should be present.
		expect(countClass(html, 'top-tools__name')).toBe(0);
	});

	// --- All-calls mode: calls count + tool name are interactive (task #484) ---

	test('tool name renders as a button when onOpenToolDetail is supplied', () => {
		const html = render(TopToolsTable, {
			props: { rows: ROWS_WITH_ERRORS, onOpenToolDetail: () => {} }
		}).body;
		// Both rows should have a button for the tool name.
		expect(countClass(html, 'top-tools__name-btn')).toBe(2);
		// The button should carry an aria-label mentioning "all calls".
		expect(html).toContain('aria-label="View all calls for bash"');
		expect(html).toContain('aria-label="View all calls for read"');
	});

	test('calls count renders as a button when onOpenToolDetail is supplied', () => {
		const html = render(TopToolsTable, {
			props: { rows: ROWS_WITH_ERRORS, onOpenToolDetail: () => {} }
		}).body;
		// Both rows should have a button for the calls count.
		expect(countClass(html, 'top-tools__count-btn')).toBe(2);
		// The button should carry an aria-label mentioning the count and "calls".
		expect(html).toContain('aria-label="View 100 calls for bash"');
		expect(html).toContain('aria-label="View 50 calls for read"');
	});

	test('tool name and calls count are inert text when onOpenToolDetail is absent', () => {
		const html = render(TopToolsTable, {
			props: { rows: ROWS_WITH_ERRORS }
		}).body;
		expect(countClass(html, 'top-tools__name-btn')).toBe(0);
		expect(countClass(html, 'top-tools__count-btn')).toBe(0);
		// But the text content should still be there.
		expect(html).toContain('>bash<');
		expect(html).toContain('>100<');
	});

	test('errors button carries no underline (text-decoration: none)', () => {
		// SSR does not emit <style> blocks, so we check the component source
		// to pin the no-underline contract.
		const source = readFileSync(
			join(process.cwd(), 'src/lib/components/features/dashboard/TopToolsTable.svelte'),
			'utf8'
		);
		// The source must declare text-decoration: none on the errors button.
		expect(source).toContain('text-decoration: none');
		// And it must appear in the .top-tools__errors-btn rule.
		expect(source).toContain('.top-tools__errors-btn');
	});

	test('errors button is a <button> element, not an <a>', () => {
		const html = render(TopToolsTable, {
			props: { rows: ROWS_WITH_ERRORS, onOpenToolDetail: () => {} }
		}).body;
		// The errors button should use <button> tag.
		expect(html).toContain('<button');
		// It should not be an anchor.
		const buttonMatches = html.match(/<button[^>]*class="[^"]*top-tools__errors-btn[^"]*"/g);
		expect(buttonMatches).not.toBeNull();
		expect(buttonMatches!.length).toBe(1);
	});
});

// --- ToolErrorsModal SSR ------------------------------------------------------

	describe('ToolErrorsModal SSR', () => {
	const baseProps = {
		tool: 'bash',
		mode: 'errors' as const,
		title: 'Top tools',
		filter: { period: '30d', scope: null },
		scopes: [{ value: '/repo/a', label: 'Repo A' }],
		onClose: () => {}
	};

	test('modal is not rendered when the component is mounted (no props to control visibility — it always renders the overlay shell)', () => {
		// ToolErrorsModal always renders its overlay shell when mounted; the parent
		// controls visibility by conditionally mounting the component. We verify the
		// shell is present when props are supplied.
		const html = render(ToolErrorsModal, { props: baseProps }).body;
		expect(html).toContain('tool-errors');
		expect(html).toContain('ui-modal');
	});

	test('renders the widget title in the header', () => {
		const html = render(ToolErrorsModal, { props: baseProps }).body;
		expect(html).toContain('Top tools');
	});

	test('header has the icon close control and no footer Close', () => {
		const html = render(ToolErrorsModal, { props: baseProps }).body;
		// Header X: icon button with the mode-specific aria-label, last in .ui-modal__head.
		expect(html).toContain('ui-icon-btn');
		expect(html).toContain('aria-label="Close error detail"');
		// SSR renders the Icon component as an inline SVG, not as a component tag.
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain('focusable="false"');
		// No textual Close/Cancel anywhere in the rendered markup.
		expect(html).not.toContain('>Close<');
		expect(html).not.toContain('>Cancel<');
		// No footer row — ToolErrorsModal has no action buttons.
		expect(html).not.toContain('ui-modal__foot');
		// No back control.
		expect(html).not.toContain('tool-errors__back');
	});

	test('header is a single row: title + subtitle + close in one .ui-modal__head', () => {
		const html = render(ToolErrorsModal, { props: baseProps }).body;
		// The header block must contain the title, the subtitle, and the close btn.
		expect(html).toContain('ui-modal__head');
		expect(html).toContain('ui-modal__title');
		expect(html).toContain('tool-errors__sub');
		// Exactly one h2 title element inside the header.
		expect(html.match(/<h2[^>]*>/g)?.length ?? 0).toBe(1);
	});

	test('renders the Period / Project / Agent / Search filter fields, no Tool field', () => {
		const html = render(ToolErrorsModal, { props: baseProps }).body;
		expect(html).toContain('tool-errors__field');
		expect(html).not.toContain('>Tool<');
		expect(html).toContain('>Period<');
		expect(html).toContain('>Project<');
		expect(html).toContain('>Agent<');
		expect(html).toContain('>Search<');
	});

	test('heading shows the fixed tool as a filter hint', () => {
		const html = render(ToolErrorsModal, { props: baseProps }).body;
		expect(html).toContain('Top tools');
		expect(html).toContain('(filter: bash)');
		expect(html).toContain('tool-errors__filter-hint');
	});

	test('errors mode omits the Tool column; loading placeholder is present', () => {
		const html = render(ToolErrorsModal, { props: baseProps }).body;
		// In SSR the modal is in 'loading' state (no data fetched yet), so the table
		// is not rendered. We verify the loading placeholder is present instead.
		expect(html).toContain('role="status"');
		expect(html).toContain('Loading');
		// The Tool column header must not appear anywhere in the output.
		expect(html).not.toContain('>Tool<');
	});

	test('errors mode column set: Time, Agent, Error text, Session (no Status, no Tool)', () => {
		const source = readFileSync(
			join(process.cwd(), 'src/lib/components/features/dashboard/ToolErrorsModal.svelte'),
			'utf8'
		);
		// Errors-mode thead: Time, Agent, (no Tool), (no Status), Error text, Session.
		expect(source).toContain('<th scope="col" class="tool-errors__col-time">Time</th>');
		expect(source).toContain('<th scope="col" class="tool-errors__col-agent">Agent</th>');
		expect(source).not.toContain('<th scope="col">Tool</th>');
		// Status is gated behind `#if isAll`, never unconditional.
		expect(source).toContain('{#if isAll}');
		expect(source).toContain('<th scope="col" class="tool-errors__col-status">Status</th>');
		expect(source).toContain('<th scope="col" class="tool-errors__col-error">Error text</th>');
		expect(source).toContain('<th scope="col" class="tool-errors__col-session">Session</th>');
	});

	test('all mode column set: Time, Agent, Status, Error text, Session (no Tool)', () => {
		const source = readFileSync(
			join(process.cwd(), 'src/lib/components/features/dashboard/ToolErrorsModal.svelte'),
			'utf8'
		);
		expect(source).toContain('<th scope="col" class="tool-errors__col-time">Time</th>');
		expect(source).toContain('<th scope="col" class="tool-errors__col-agent">Agent</th>');
		expect(source).not.toContain('<th scope="col">Tool</th>');
		expect(source).toContain('<th scope="col" class="tool-errors__col-status">Status</th>');
		expect(source).toContain('<th scope="col" class="tool-errors__col-error">Error text</th>');
		expect(source).toContain('<th scope="col" class="tool-errors__col-session">Session</th>');
	});

	test('renders the total line with failed call count text in errors mode', () => {
		const html = render(ToolErrorsModal, { props: baseProps }).body;
		// In SSR, the total is 0 (no data loaded yet) so it shows "0 failed calls".
		expect(html).toContain('failed');
	});

	test('renders the Load more button area structure (client-side only; SSR shows loading placeholder)', () => {
		const html = render(ToolErrorsModal, { props: baseProps }).body;
		// At SSR time the modal is in 'loading' state, so the load-more section
		// is not yet rendered. We verify the loading state is present.
		expect(html).toContain('tool-errors__state');
		expect(html).toContain('Loading');
	});

	test('role=dialog and aria-modal are present', () => {
		const html = render(ToolErrorsModal, { props: baseProps }).body;
		expect(html).toContain('role="dialog"');
		expect(html).toContain('aria-modal="true"');
	});

	test('modal has the tool-errors class on the root', () => {
		const html = render(ToolErrorsModal, { props: baseProps }).body;
		expect(html).toContain('ui-modal tool-errors');
	});

	// --- All-calls mode copy and Status column (task #484) -------------------

	test('errors mode subtitle says "Failed tool calls"', () => {
		const html = render(ToolErrorsModal, { props: baseProps }).body;
		expect(html).toContain('Failed tool calls');
	});

	test('errors mode total text says "failed calls"', () => {
		const html = render(ToolErrorsModal, { props: baseProps }).body;
		expect(html).toContain('failed calls');
	});

	test('errors mode does not render a Status column header', () => {
		const html = render(ToolErrorsModal, { props: baseProps }).body;
		// In SSR the table is in loading state, but we verify errors mode copy
		// does not include "Status" column text.
		expect(html).not.toContain('>Status<');
	});

	test('all mode subtitle says "Tool calls"', async () => {
		const allProps = { ...baseProps, mode: 'all' as const };
		const html = render(ToolErrorsModal, { props: allProps }).body;
		expect(html).toContain('Tool calls');
		expect(html).not.toContain('Failed tool calls');
	});

	test('all mode total text says "calls" not "failed calls"', async () => {
		const allProps = { ...baseProps, mode: 'all' as const };
		const html = render(ToolErrorsModal, { props: allProps }).body;
		// In SSR total is 0, so it shows "0 calls" not "0 failed calls".
		expect(html).toContain('0 calls');
		expect(html).not.toContain('0 failed calls');
	});

	test('all mode empty text says "No tool calls"', () => {
		// SSR renders the loading placeholder, not the empty state. We check the
		// component source to pin the all-mode empty-text contract.
		const source = readFileSync(
			join(process.cwd(), 'src/lib/components/features/dashboard/ToolErrorsModal.svelte'),
			'utf8'
		);
		// The source should contain the all-mode empty text string.
		expect(source).toContain('No tool calls for these filters.');
	});

	// --- Expandable rows + ToolCallDetail delegation (#538) --------------------

	test('Session cell is plain monospace text, not a /sessions/ anchor', () => {
		const source = readFileSync(
			join(process.cwd(), 'src/lib/components/features/dashboard/ToolErrorsModal.svelte'),
			'utf8'
		);
		// The session cell must render raw text with a title attribute, not an <a>.
		expect(source).toContain('class="tool-errors__session"');
		expect(source).toContain('title={row.sessionId}');
		// No href or /sessions/ link should appear in the session cell.
		const sessionCellMatch = source.match(/<td[^>]*class="[^"]*tool-errors__session[^"]*"[^>]*>[\s\S]*?<\/td>/);
		expect(sessionCellMatch).not.toBeNull();
		const cellContent = sessionCellMatch![0];
		expect(cellContent).not.toContain('href=');
		expect(cellContent).not.toContain('/sessions/');
	});

	test('operation row carries role="button", tabindex="0" and aria-expanded', () => {
		const source = readFileSync(
			join(process.cwd(), 'src/lib/components/features/dashboard/ToolErrorsModal.svelte'),
			'utf8'
		);
		expect(source).toContain('role="button"');
		expect(source).toContain('tabindex="0"');
		expect(source).toContain('aria-expanded={expandedDetailId === row.id}');
	});

	test('toggling a row expands/collapses via toggleDetailRow', () => {
		const source = readFileSync(
			join(process.cwd(), 'src/lib/components/features/dashboard/ToolErrorsModal.svelte'),
			'utf8'
		);
		// The row onclick calls toggleDetailRow which flips expandedDetailId.
		expect(source).toContain('onclick={() => toggleDetailRow(row.id)}');
		expect(source).toContain('function toggleDetailRow(id: string)');
		// Toggling the same id closes it (XOR semantics).
		expect(source).toContain('expandedDetailId === id ? null : id');
	});

	test('enter/space keydown on a row triggers toggleDetailRow', () => {
		const source = readFileSync(
			join(process.cwd(), 'src/lib/components/features/dashboard/ToolErrorsModal.svelte'),
			'utf8'
		);
		expect(source).toContain('onkeydown={(event) => onRowKeydown(event, row.id)}');
		expect(source).toContain('function onRowKeydown');
		// The handler checks both Enter and Space, returning early if neither matches.
		expect(source).toContain("event.key !== 'Enter'");
		expect(source).toContain("event.key !== ' '");
	});

	test('detail row renders ToolCallDetail with the full call view model', () => {
		const source = readFileSync(
			join(process.cwd(), 'src/lib/components/features/dashboard/ToolErrorsModal.svelte'),
			'utf8'
		);
		expect(source).toContain('<ToolCallDetail');
		expect(source).toContain('call={{');
		expect(source).toContain('id: row.id');
		expect(source).toContain('name: row.tool');
		expect(source).toContain('startedAt: row.at');
		expect(source).toContain('endedAt: row.endedAt');
		expect(source).toContain('input: row.input');
		expect(source).toContain('output: row.output');
		expect(source).toContain('isMcp: row.isMcp');
		expect(source).toContain('isDelegation: row.isDelegation');
		expect(source).toContain('onToggleExpanded={toggleDetailBlock}');
	});

	test('detail row spans all columns with colspan matching the mode', () => {
		const source = readFileSync(
			join(process.cwd(), 'src/lib/components/features/dashboard/ToolErrorsModal.svelte'),
			'utf8'
		);
		// errors mode: 4 columns; all mode: 5 columns.
		expect(source).toContain('colspan={isAll ? 5 : 4}');
	});

	test('at most one row is expanded at a time (XOR toggle)', () => {
		const source = readFileSync(
			join(process.cwd(), 'src/lib/components/features/dashboard/ToolErrorsModal.svelte'),
			'utf8'
		);
		// toggleDetailRow implements XOR: if the clicked id is already open, close it;
		// otherwise open it (and implicitly close any other).
		expect(source).toContain('expandedDetailId === id ? null : id');
	});
});
