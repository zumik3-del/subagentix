<script lang="ts">
	/**
	 * Shared per-day table body (widget engine, task #491).
	 *
	 * The single parameterized body behind both `sessions-per-day` and
	 * `cost-per-day`: `WidgetShell` owns the fetch and the card chrome and spreads
	 * the descriptor's `params` (`label` + `formatValue`) in, so the two widgets
	 * differ only by those two values. Content-only by contract — it draws the
	 * newest-first day table (`DayTable`) from the typed payload it receives.
	 */
	import type { DayBucket } from '$lib/model/chart';
	import DayTable from './DayTable.svelte';

	interface Props {
		/** Dense UTC-day buckets (`{ day, value }`, ascending) from the shell. */
		data: readonly DayBucket[];
		/** Series name (e.g. `Sessions`); the table caption and value header. */
		label: string;
		/** Row-value formatter (`formatNumber` / `formatCost`). */
		formatValue: (value: number) => string;
	}

	let { data, label, formatValue }: Props = $props();
</script>

<DayTable points={data} {label} {formatValue} />
