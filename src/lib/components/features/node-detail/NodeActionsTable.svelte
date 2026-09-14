<script module lang="ts">
	/**
	 * Row-kind filter for the Steps & actions table. Exported so the feature
	 * root can type its `kindFilter` state against the same union the filter
	 * controls render.
	 */
	export type RowFilter = 'all' | 'step' | 'tool' | 'text' | 'reasoning' | 'files' | 'misc';

	export const ROW_FILTERS: ReadonlyArray<{ value: RowFilter; label: string }> = [
		{ value: 'all', label: 'All' },
		{ value: 'step', label: 'Steps' },
		{ value: 'tool', label: 'Tools' },
		{ value: 'text', label: 'Text' },
		{ value: 'reasoning', label: 'Reasoning' },
		{ value: 'files', label: 'Files' },
		{ value: 'misc', label: 'Other' }
	];
</script>

<script lang="ts">
	/**
	 * Steps & actions table (extracted from `NodeDetailPanel`, ADR 2.6).
	 *
	 * The table section: heading + search, row-kind/permission filters, the
	 * hierarchical step/child/marker `<tr>` table, and the floating
	 * back-to-table button with its `IntersectionObserver`. Pure presentation —
	 * the panel root owns the filter/expand state, the derived `visibleRows`
	 * (each with its resolved `open` flag) and the cross-block jump callbacks,
	 * passing them down. Each `<tr>` is rendered by `StepRow` / `SubRow`.
	 */
	import type { NodeRow } from '$lib/model/node';
	import Icon from '$lib/components/primitives/Icon.svelte';
	import ScrollView from '$lib/components/primitives/ScrollView.svelte';
	import StepRow from './StepRow.svelte';
	import SubRow from './SubRow.svelte';
	import BackToTableButton from '$lib/components/composites/BackToTableButton.svelte';

	interface VisibleRow {
		row: NodeRow;
		children: NodeRow[];
		/** Resolved by the root's `isOpen` (expanded record OR active filter). */
		open: boolean;
	}

	interface Props {
		visibleRows: VisibleRow[];
		stepCount: number;
		itemCount: number;
		hasContent: boolean;
		usageColumns: string[];
		kindFilter: RowFilter;
		permissionOnly: boolean;
		actionSearch: string;
		allExpanded: boolean;
		/** Two-way search text (state stays in the panel root). */
		onSearch: (value: string) => void;
		onFilter: (value: RowFilter) => void;
		onTogglePermission: () => void;
		onToggleAll: () => void;
		onToggleRow: (key: string) => void;
		/** Jump to a tool-call detail block (owned by the panel root). */
		onFocusCall: (event: MouseEvent, id: string) => void;
		/** Jump to an action detail block (owned by the panel root). */
		onFocusAction: (event: MouseEvent, id: string | null) => void;
	}

	let {
		visibleRows,
		stepCount,
		itemCount,
		hasContent,
		usageColumns,
		kindFilter,
		permissionOnly,
		actionSearch,
		allExpanded,
		onSearch,
		onFilter,
		onTogglePermission,
		onToggleAll,
		onToggleRow,
		onFocusCall,
		onFocusAction
	}: Props = $props();

	/** Steps & actions table element, watched to reveal the floating back button. */
	let tableEl: HTMLElement | null = $state(null);
	/** Steps & actions section heading target for the floating back button. */
	let tableSectionEl: HTMLElement | null = $state(null);
	let showBackToTable = $state(false);

	/** Jump back to the top of the Steps & actions section (its heading). */
	function backToTable() {
		(tableSectionEl ?? tableEl)?.scrollIntoView({
			behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
			block: 'start'
		});
	}

	// Reveal the floating "back to table" button once the Steps & actions
	// table has scrolled off the top (i.e. the user is down in Details),
	// and hide it again as soon as the table is back in view. The app scrolls
	// inside an inner ScrollView viewport, not the window, so observe the
	// table against that scrollport as the IntersectionObserver root.
	$effect(() => {
		const el = tableEl;
		if (!el) {
			showBackToTable = false;
			return;
		}
		const root = el.closest<HTMLElement>('.scroll-view__viewport--vertical');
		const observer = new IntersectionObserver(
			([entry]) => {
				showBackToTable = !entry.isIntersecting && entry.boundingClientRect.height > 0;
			},
			{ root, threshold: 0 }
		);
		observer.observe(el);
		return () => observer.disconnect();
	});
</script>

<section class="block" bind:this={tableSectionEl}>
	<div class="actions-head">
		<h4>Steps &amp; actions ({stepCount} steps · {itemCount} items)</h4>
		<input
			class="ui-input search"
			type="search"
			placeholder="Filter rows…"
			aria-label="Filter steps and actions"
			value={actionSearch}
			oninput={(event) => onSearch(event.currentTarget.value)}
		/>
	</div>
	<div class="filters" role="group" aria-label="Row type filter">
		<button
			type="button"
			class="ui-btn toggle-all"
			aria-pressed={allExpanded}
			aria-label={allExpanded ? 'Collapse all steps' : 'Expand all steps'}
			title={allExpanded ? 'Collapse all' : 'Expand all'}
			onclick={onToggleAll}
		>
			<Icon name={allExpanded ? 'collapse' : 'expand'} size={14} />
		</button>
		{#each ROW_FILTERS as filter (filter.value)}
			<button
				type="button"
				class="ui-chip ui-chip--toggle filter"
				class:active={kindFilter === filter.value}
				onclick={() => onFilter(filter.value)}
			>
				{filter.label}
			</button>
		{/each}
		<button
			type="button"
			class="ui-chip ui-chip--toggle filter filter-perm"
			class:active={permissionOnly}
			onclick={onTogglePermission}
		>
			Permission
		</button>
	</div>
	{#if !hasContent}
		<p class="empty">No steps or actions recorded for this node.</p>
	{:else if visibleRows.length === 0}
		<p class="empty">No rows match the current filter.</p>
	{:else}
		<div class="table-scroll" bind:this={tableEl}>
			<ScrollView orientation="horizontal">
			<table>
				<thead>
					<tr>
						<th scope="col" class="col-num">#</th>
						<th scope="col" class="col-event">Event / action</th>
						<th scope="col" class="col-time">Start</th>
						<th scope="col" class="col-time">End</th>
						<th scope="col" class="col-time">Duration</th>
						{#each usageColumns as label (label)}
							<th scope="col" class="num col-token">{label}</th>
						{/each}
						<th scope="col" class="num col-cost">Cost</th>
					</tr>
				</thead>
				<tbody>
					{#each visibleRows as entry (entry.row.key)}
						{#if entry.row.kind === 'step'}
							<StepRow
								row={entry.row}
								childRows={entry.children}
								open={entry.open}
								{usageColumns}
								onToggle={onToggleRow}
								{onFocusCall}
								{onFocusAction}
							/>
						{:else}
							<SubRow
								row={entry.row}
								nested={false}
								{usageColumns}
								{onFocusCall}
								{onFocusAction}
							/>
						{/if}
					{/each}
				</tbody>
			</table>
			</ScrollView>
		</div>
	{/if}
	<BackToTableButton visible={showBackToTable} onClick={backToTable} />
</section>

<style>
	/* `block`/head/filter/`th` chrome moved verbatim from the panel; `td` chrome
	   lives in `StepRow`/`SubRow` where those cells render. */
	.block {
		margin-top: var(--space-4);
	}

	.block h4 {
		margin: 0 0 var(--space-1);
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.actions-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-bottom: var(--space-1);
	}

	.actions-head h4 {
		margin: 0;
	}

	.search {
		flex: 0 1 18rem;
		min-width: 8rem;
	}

	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		margin-bottom: var(--space-2);
	}

	/* Single square icon button that toggles expand/collapse for all steps. */
	.toggle-all {
		padding: 0 var(--space-1);
		color: var(--text-interactive-base);
	}

	.filter.active {
		background: var(--surface-interactive-base);
		color: var(--text-strong);
		border-color: var(--border-selected);
	}

	.empty {
		color: var(--text-weak);
		font-size: var(--font-size-small);
		margin: 0;
		display: flex;
		align-items: center;
		min-height: var(--space-6);
	}

	.table-scroll {
		overflow: hidden;
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
	}

	table {
		border-collapse: separate;
		border-spacing: 0;
		table-layout: fixed;
		width: 100%;
		min-width: 74rem;
		font-size: var(--font-size-sm);
		white-space: nowrap;
	}

	th {
		padding: var(--space-1) var(--space-2);
		border-bottom: 1px solid var(--border-weaker-base);
		text-align: left;
		vertical-align: middle;
	}

	th {
		color: var(--text-weak);
		font-weight: var(--font-weight-medium);
		background: var(--surface-base);
	}

	/* Fixed column widths so expanding a step never shifts the layout. */
	.col-num {
		width: 2rem;
		padding-left: var(--space-1);
		padding-right: var(--space-1);
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.col-event {
		width: 20rem;
		padding-left: var(--space-1);
	}

	.col-time {
		width: 6.5rem;
	}

	.col-token {
		width: 6rem;
	}

	.col-cost {
		width: 6rem;
	}

	/* Pin the first two columns while the token columns scroll horizontally. */
	.col-num,
	.col-event {
		position: sticky;
		z-index: 2;
		background: var(--background-strong);
	}

	.col-num {
		left: 0;
	}

	.col-event {
		left: 2rem;
		overflow: hidden;
	}

	th.col-num,
	th.col-event {
		z-index: 3;
		background: var(--surface-base);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
</style>
