<script lang="ts">
	/**
	 * In-place tool-call detail overlay for the top-tools widget (task #481;
	 * all-calls mode #484).
	 *
	 * Opened by the Errors/Calls/name cells of `TopToolsWidget`; the shell mounts
	 * it from the `?toolErrors=` (failures) or `?toolCalls=` (all calls) URL
	 * param, so it opens over the dashboard (no separate route), a deep link
	 * restores it, and browser Back closes it. The clicked tool is fixed (shown
	 * in the heading, sent on every request); the remaining server-side filters
	 * are status mode, period, project and agent, plus a debounced error-text
	 * search and limit/offset paging through the shared
	 * `/api/dashboard/tool-errors`.
	 *
	 * In `all` mode every call is listed and a raw `Status` column is added; in
	 * `errors` mode only failed calls appear (Time, Agent, Error text, Session).
	 * The copy (subtitle, total, empty state) follows the mode.
	 *
	 * Since #538 each operation row is a keyboard-activatable toggle (click or
	 * Enter/Space) that reveals one full-width detail row rendering the shared
	 * `ToolCallDetail`; at most the clicked row is open and its input/output
	 * blobs expand independently. The Session cell is plain monospace text
	 * (no `/sessions/...` link).
	 *
	 * Every operation row is a single line: the table uses a fixed layout with
	 * per-column widths and ellipsised cells, so a row never wraps and revealing
	 * a detail row never shifts the columns. The full value stays reachable via
	 * the cell `title` (and, for the error, the revealed detail card).
	 *
	 * Follows the modal conventions of `TaskModal` / `WidgetSettings`
	 * (docs/ui-standards.md §9): backdrop button, dialog semantics, Escape close,
	 * a Tab trap, initial focus and focus return to the opener, and no markup
	 * while closed (the shell renders it only when open).
	 */
	import { untrack } from 'svelte';
	import type { DashboardFilter, DashboardPeriod } from '$lib/model/dashboard';
	import { isDashboardPeriod } from '$lib/model/dashboard';
	import type { ToolCallStatus, ToolErrorEntry, ToolErrorsPage } from '$lib/model/tool-errors';
	import { DEFAULT_ERROR_LIMIT } from '$lib/model/tool-errors';
	import { formatDateTime, formatNumber } from '$lib/model/format';
	import { clock } from '$lib/model/clock.svelte';
	import Icon from '$lib/components/primitives/Icon.svelte';
	import ScrollView from '$lib/components/primitives/ScrollView.svelte';
	import ToolCallDetail from '$lib/components/composites/ToolCallDetail.svelte';
	import { ALL_SCOPE_OPTION, PERIOD_OPTIONS, SCOPE_ALL, type FilterOption } from './filter';
	import { appendToolErrorRows, buildToolErrorsUrl, type ToolErrorViewFilters } from './tool-errors';

	interface Props {
		/** Initial tool filter; comes from the clicked widget row. */
		tool: string;
		/** Detail mode: `errors` = failed only, `all` = every call. */
		mode: ToolCallStatus;
		/** Widget title shown in the header (e.g. `Top tools`). */
		title: string;
		/** Dashboard filter seeding period/scope. */
		filter: DashboardFilter;
		/** Directory options for the project filter (no `All projects` entry). */
		scopes?: readonly FilterOption[];
		/** Close/leave the overlay (the shell clears the URL param). */
		onClose: () => void;
	}

	let { tool, mode, title, filter, scopes = [], onClose }: Props = $props();

	/** One page request; the search is debounced so typing does not spam it. */
	const PAGE_SIZE = DEFAULT_ERROR_LIMIT;
	const SEARCH_DEBOUNCE_MS = 300;

	let dialog = $state<HTMLDivElement | null>(null);
	let previouslyFocused: HTMLElement | null = null;

	// Editable filter state, seeded once from the click + the dashboard filter
	// (the shell mounts the modal per open, so the snapshot never goes stale).
	// The tool is NOT editable state: it is fixed by the row click and read
	// straight from the immutable `tool` prop on every request.
	let callStatus = untrack(() => mode);
	let period = $state(untrack(() => filter.period));
	let scope = $state(untrack(() => filter.scope));
	let agent = $state('');
	let search = $state('');
	let debouncedSearch = $state('');

	// Result state.
	let rows = $state<ToolErrorEntry[]>([]);
	let total = $state(0);
	let agents = $state<string[]>([]);
	let capped = $state(false);
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let error = $state<string | null>(null);
	let loadingMore = $state(false);
	/** A failed "Load more"; the already-loaded rows stay on screen. */
	let loadMoreError = $state<string | null>(null);

	/** The one expanded operation row (`null` = none); reveals its detail card. */
	let expandedDetailId = $state<string | null>(null);
	/** Input/output blob expansion inside the revealed `ToolCallDetail`. */
	let expandedBlocks = $state<Record<string, boolean>>({});

	/** Monotonic request id, so a late response can never overwrite a newer one. */
	let requestSeq = 0;

	/** `all` lists every call and adds a Status column; `errors` is failures only. */
	let isAll = $derived(callStatus === 'all');
	/** Mode-dependent copy: subtitle, total line and empty state. */
	let subtitle = $derived(isAll ? 'Tool calls' : 'Failed tool calls');
	let totalText = $derived(
		isAll
			? `${formatNumber(total)} ${total === 1 ? 'call' : 'calls'}`
			: `${formatNumber(total)} ${total === 1 ? 'failed call' : 'failed calls'}`
	);
	let emptyText = $derived(
		isAll ? 'No tool calls for these filters.' : 'No failed tool calls for these filters.'
	);

	let scopeChoices = $derived<readonly FilterOption[]>([ALL_SCOPE_OPTION, ...scopes]);
	let agentChoices = $derived<readonly FilterOption[]>([
		{ value: '', label: 'All agents' },
		...agents.map((name) => ({ value: name, label: name }))
	]);
	let hasMore = $derived(rows.length < total);

	function currentFilters(): ToolErrorViewFilters {
		return {
			status: callStatus,
			tool,
			period,
			scope,
			agent,
			search: debouncedSearch
		};
	}

	/** Best-effort error text: the API's `error` field, else the HTTP status. */
	async function responseError(response: Response): Promise<string> {
		try {
			const body: unknown = await response.json();
			if (
				body !== null &&
				typeof body === 'object' &&
				typeof (body as { error?: unknown }).error === 'string'
			) {
				return (body as { error: string }).error;
			}
		} catch {
			// Non-JSON error body: fall through to the status message.
		}
		return `Request failed (${response.status}).`;
	}

	async function requestPage(
		filters: ToolErrorViewFilters,
		offset: number,
		signal?: AbortSignal
	): Promise<ToolErrorsPage> {
		const response = await fetch(buildToolErrorsUrl(filters, PAGE_SIZE, offset), {
			signal,
			headers: { accept: 'application/json' }
		});
		if (!response.ok) throw new Error(await responseError(response));
		return (await response.json()) as ToolErrorsPage;
	}

	// First page: runs on mount and whenever a filter changes. It reads only the
	// filter state, so its own result writes cannot retrigger it.
	$effect(() => {
		const filters = currentFilters();
		const seq = ++requestSeq;
		const controller = new AbortController();
		status = 'loading';
		error = null;
		rows = [];
		// A filter change abandons any in-flight "Load more"; reset its flag so
		// the fresh page can page again.
		loadingMore = false;
		loadMoreError = null;
		// A filter change replaces the rows, so an expanded row and its blobs
		// can never point at the new page.
		expandedDetailId = null;
		expandedBlocks = {};

		void (async () => {
			try {
				const page = await requestPage(filters, 0, controller.signal);
				if (controller.signal.aborted || seq !== requestSeq) return;
				rows = page.rows;
				total = page.total;
				agents = page.agents;
				capped = page.capped;
				status = 'ready';
			} catch (cause) {
				if (controller.signal.aborted || seq !== requestSeq) return;
				error = cause instanceof Error ? cause.message : String(cause);
				status = 'error';
			}
		})();

		return () => controller.abort();
	});

	// Debounce the search term: each keystroke restarts the timer, so only a
	// settled value reaches the fetch effect above.
	$effect(() => {
		const value = search;
		const timer = setTimeout(() => {
			debouncedSearch = value;
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	});

	async function loadMore(): Promise<void> {
		if (loadingMore || !hasMore) return;
		const seq = requestSeq;
		loadingMore = true;
		loadMoreError = null;
		try {
			const page = await requestPage(currentFilters(), rows.length);
			if (seq !== requestSeq) return;
			rows = appendToolErrorRows(rows, page);
			total = page.total;
			agents = page.agents;
			capped = page.capped;
		} catch (cause) {
			if (seq !== requestSeq) return;
			loadMoreError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			if (seq === requestSeq) loadingMore = false;
		}
	}

	function setPeriod(value: string): void {
		if (isDashboardPeriod(value)) period = value;
	}

	function setScope(value: string): void {
		scope = value === SCOPE_ALL ? null : value;
	}

	/** Toggle one operation row's detail card; at most the clicked row is open. */
	function toggleDetailRow(id: string): void {
		expandedDetailId = expandedDetailId === id ? null : id;
	}

	/** Enter/Space toggle a focused row, mirroring a button's activation. */
	function onRowKeydown(event: KeyboardEvent, id: string): void {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		toggleDetailRow(id);
	}

	/** Expand/collapse one input/output blob inside the revealed detail card. */
	function toggleDetailBlock(key: string): void {
		expandedBlocks[key] = !expandedBlocks[key];
	}

	$effect(() => {
		previouslyFocused =
			typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
	});

	$effect(() => {
		dialog?.focus();
		return () => previouslyFocused?.focus();
	});

	function onDialogKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key !== 'Tab' || !dialog) return;
		const focusables = Array.from(
			dialog.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
			)
		);
		if (focusables.length === 0) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = document.activeElement;
		if (event.shiftKey && (active === first || !dialog.contains(active))) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && active === last) {
			event.preventDefault();
			first.focus();
		}
	}
</script>

<div class="ui-modal tool-errors">
	<button type="button" class="ui-modal__backdrop" aria-label="Close error detail" onclick={onClose}
	></button>
	<div
		class="ui-modal__dialog tool-errors__dialog"
		role="dialog"
		aria-modal="true"
		aria-labelledby="tool-errors-title"
		tabindex="-1"
		bind:this={dialog}
		onkeydown={onDialogKeydown}
	>
		<header class="ui-modal__head">
			<h2 class="ui-modal__title" id="tool-errors-title">
				{title}
				<span class="tool-errors__filter-hint">(filter: {tool})</span>
			</h2>
			<p class="tool-errors__sub">{subtitle}</p>
			<button type="button" class="ui-icon-btn" aria-label="Close error detail" onclick={onClose}>
				<Icon name="close" />
			</button>
		</header>

		<div class="tool-errors__filters">
			<label class="tool-errors__field">
				<span class="tool-errors__label">Period</span>
				<select
					class="ui-select tool-errors__select"
					value={period}
					onchange={(event) => setPeriod(event.currentTarget.value)}
				>
					{#each PERIOD_OPTIONS as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
			</label>
			<label class="tool-errors__field">
				<span class="tool-errors__label">Project</span>
				<select
					class="ui-select tool-errors__select"
					value={scope ?? SCOPE_ALL}
					onchange={(event) => setScope(event.currentTarget.value)}
				>
					{#each scopeChoices as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
			</label>
			<label class="tool-errors__field">
				<span class="tool-errors__label">Agent</span>
				<select
					class="ui-select tool-errors__select"
					value={agent}
					onchange={(event) => (agent = event.currentTarget.value)}
				>
					{#each agentChoices as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
			</label>
			<label class="tool-errors__field tool-errors__field--search">
				<span class="tool-errors__label">Search</span>
				<input
					class="ui-input tool-errors__input"
					type="search"
					placeholder="Filter error text…"
					value={search}
					oninput={(event) => (search = event.currentTarget.value)}
				/>
			</label>
		</div>

		<p class="tool-errors__total" aria-live="polite">
			{totalText}
			{#if capped}
				<span class="tool-errors__capped">
					(approximate — only the most recent sessions in range are counted)
				</span>
			{/if}
		</p>

		<div class="ui-modal__body">
			<ScrollView>
				<div class="ui-modal__content tool-errors__content">
					{#if status === 'loading'}
						<p class="tool-errors__state" role="status">Loading…</p>
					{:else if status === 'error'}
						<p class="tool-errors__state tool-errors__state--error" role="alert">{error}</p>
					{:else if rows.length === 0}
						<p class="tool-errors__state">{emptyText}</p>
					{:else}
						<table class="tool-errors__table">
							<caption class="sr-only">{subtitle}, newest first</caption>
							<thead>
								<tr>
									<th scope="col" class="tool-errors__col-time">Time</th>
									<th scope="col" class="tool-errors__col-agent">Agent</th>
									{#if isAll}
										<th scope="col" class="tool-errors__col-status">Status</th>
									{/if}
									<th scope="col" class="tool-errors__col-error">Error text</th>
									<th scope="col" class="tool-errors__col-session">Session</th>
								</tr>
							</thead>
							<tbody>
								{#each rows as row (row.id)}
									<tr
										class="tool-errors__row"
										class:open={expandedDetailId === row.id}
										role="button"
										tabindex="0"
										aria-expanded={expandedDetailId === row.id}
										onclick={() => toggleDetailRow(row.id)}
										onkeydown={(event) => onRowKeydown(event, row.id)}
									>
										<td class="tool-errors__time">{formatDateTime(row.at, clock.tz)}</td>
										<td class="tool-errors__agent" title={row.agent}>{row.agent}</td>
										{#if isAll}
											<td class="tool-errors__status">
												{row.status === '' ? '—' : row.status}
											</td>
										{/if}
										<td class="tool-errors__error" title={row.error === '' ? undefined : row.error}>
											{row.error === '' ? '—' : row.error}
										</td>
										<td class="tool-errors__session" title={row.sessionId}>{row.sessionId}</td>
									</tr>
									{#if expandedDetailId === row.id}
										<tr class="tool-errors__detail">
											<td colspan={isAll ? 5 : 4}>
												<div class="tool-errors__detail-cell">
													<ToolCallDetail
														call={{
															id: row.id,
															name: row.tool,
															status: row.status,
															error: row.error === '' ? null : row.error,
															startedAt: row.at,
															endedAt: row.endedAt,
															input: row.input,
															output: row.output,
															isMcp: row.isMcp,
															isDelegation: row.isDelegation
														}}
														expanded={expandedBlocks}
														onToggleExpanded={toggleDetailBlock}
													/>
												</div>
											</td>
										</tr>
									{/if}
								{/each}
							</tbody>
						</table>

						{#if hasMore}
							<div class="tool-errors__more">
								<button
									type="button"
									class="ui-btn"
									onclick={loadMore}
									disabled={loadingMore}
								>
									{loadingMore ? 'Loading…' : 'Load more'}
								</button>
								{#if loadMoreError}
									<p class="tool-errors__state tool-errors__state--error" role="alert">
										{loadMoreError}
									</p>
								{/if}
							</div>
						{/if}
					{/if}
				</div>
			</ScrollView>
		</div>
	</div>
</div>

<style>
	/* Size only — shape/behavior come from the global `.ui-modal` contract. */
	.tool-errors {
		z-index: 110;
	}

	.tool-errors__dialog {
		width: min(80rem, calc(100vw - 2rem));
		height: calc(100dvh - 2rem);
	}

	/* Mode subtitle: right-aligned element of the single-line header row. */
	.tool-errors__sub {
		margin: 0;
		margin-inline-start: auto;
		align-self: flex-start;
		font-size: var(--font-size-small);
		color: var(--text-weak);
		text-align: right;
		white-space: nowrap;
	}

	/* The fixed tool name is a qualifier of the title, so it reads weaker. */
	.tool-errors__filter-hint {
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-regular);
		color: var(--text-weak);
	}

	.tool-errors__filters {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--border-weak-base);
	}

	.tool-errors__field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}

	.tool-errors__field--search {
		flex: 1 1 14rem;
		margin-inline-start: auto;
	}

	.tool-errors__label {
		font-size: var(--font-size-xs);
		color: var(--text-weak);
	}

	/* Sizing only — the control box comes from .ui-input / .ui-select. */
	.tool-errors__input,
	.tool-errors__select {
		min-width: 8rem;
	}

	.tool-errors__total {
		margin: 0;
		padding: var(--space-2) var(--space-4);
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}

	.tool-errors__capped {
		color: var(--color-warning-strong);
	}

	.tool-errors__state {
		margin: 0;
		color: var(--text-weak);
		font-size: var(--font-size-small);
	}

	.tool-errors__state--error {
		color: var(--color-danger-strong);
	}

	.tool-errors__table {
		width: 100%;
		border-collapse: collapse;
		table-layout: fixed;
		font-size: var(--font-size-small);
	}

	/* Fixed column widths: the error text is the only flexible column, so a
	   row or a revealed detail row can never resize the others. */
	.tool-errors__col-time {
		width: 9.5rem;
	}
	.tool-errors__col-agent {
		width: 8rem;
	}
	.tool-errors__col-status {
		width: 7rem;
	}
	.tool-errors__col-session {
		width: 12rem;
	}

	.tool-errors__table th,
	.tool-errors__table td {
		padding: var(--space-2);
		border-bottom: 1px solid var(--border-weaker-base);
		text-align: left;
		vertical-align: middle;
	}

	.tool-errors__table thead th {
		position: sticky;
		top: 0;
		background: var(--background-strong);
		color: var(--text-weak);
		font-weight: var(--font-weight-medium);
	}

	/* Operation cells render on one line: no wrap, ellipsis on overflow. */
	.tool-errors__time,
	.tool-errors__agent,
	.tool-errors__status,
	.tool-errors__error,
	.tool-errors__session {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tool-errors__time {
		font-variant-numeric: tabular-nums;
		color: var(--text-weak);
	}

	.tool-errors__session {
		font-family: var(--font-family-mono);
	}

	/* Each operation row toggles its detail row; the open row stays tinted. */
	.tool-errors__row {
		cursor: pointer;
	}

	.tool-errors__row:hover,
	.tool-errors__row.open {
		background: var(--surface-raised-base-hover);
	}

	/* The revealed call card: one full-width cell spanning every column. */
	.tool-errors__detail > td {
		padding: 0;
		background: var(--background-strong);
		border-bottom: 1px solid var(--border-weaker-base);
	}

	.tool-errors__detail-cell {
		padding: var(--space-2) var(--space-2) var(--space-3);
	}

	.tool-errors__more {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-4) 0 var(--space-2);
	}
</style>
