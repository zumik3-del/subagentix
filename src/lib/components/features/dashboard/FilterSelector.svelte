<script lang="ts">
	/**
	 * Global period + project selector (dashboard Phase 5, task #415).
	 *
	 * Presentation-only child of the dashboard shell: it renders the current
	 * filter and reports the next one through `onChange` — the shell and the
	 * landing page own the URL round-trip (`?period=&scope=`), so this component
	 * never stores or persists state. The options are precomputed
	 * (`PERIOD_OPTIONS`, `directoryOptions`) to keep the label rules out of the
	 * markup.
	 */
	import { isDashboardPeriod, type DashboardFilter } from '$lib/model/dashboard';
	import { ALL_SCOPE_OPTION, PERIOD_OPTIONS, SCOPE_ALL, type FilterOption } from './filter';

	interface Props {
		/** Current filter (URL-derived); the selects are controlled by it. */
		filter: DashboardFilter;
		/** Directory options (no `All projects` entry; prepended here). */
		scopes?: readonly FilterOption[];
		/** Reports the next filter; absent when the shell renders standalone. */
		onChange?: (filter: DashboardFilter) => void;
	}

	let { filter, scopes = [], onChange }: Props = $props();

	/** Options for the scope select: the every-directory entry first. */
	let scopeChoices = $derived<readonly FilterOption[]>([ALL_SCOPE_OPTION, ...scopes]);

	function onPeriodChange(value: string): void {
		if (!isDashboardPeriod(value) || value === filter.period) return;
		onChange?.({ ...filter, period: value });
	}

	function onScopeChange(value: string): void {
		const scope = value === SCOPE_ALL ? null : value;
		if (scope === filter.scope) return;
		onChange?.({ ...filter, scope });
	}
</script>

<div class="filter-selector">
	<select
		class="ui-select filter-selector__select"
		aria-label="Period"
		value={filter.period}
		onchange={(event) => onPeriodChange(event.currentTarget.value)}
	>
		{#each PERIOD_OPTIONS as option (option.value)}
			<option value={option.value}>{option.label}</option>
		{/each}
	</select>

	<select
		class="ui-select filter-selector__select"
		aria-label="Project"
		value={filter.scope ?? SCOPE_ALL}
		onchange={(event) => onScopeChange(event.currentTarget.value)}
	>
		{#each scopeChoices as option (option.value)}
			<option value={option.value}>{option.label}</option>
		{/each}
	</select>
</div>

<style>
	.filter-selector {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
	}

	/* Sizing only — the control box comes from .ui-select. */
	.filter-selector__select {
		max-width: 14rem;
	}
</style>
