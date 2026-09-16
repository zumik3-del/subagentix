<script lang="ts">
	/**
	 * Dashboard header (dashboard Phase 3, task #404).
	 *
	 * Fixed layout only: the title sits on the left and a right-aligned actions
	 * area reserves the slots for the Phase 5 controls — the "Widgets" picker
	 * button (#414) and the period/scope selector (#415). The shell itself owns
	 * no filter state yet (spec §2.1 / §2.8).
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		/** Header title. */
		title?: string;
		/** Right-aligned controls (widgets button, scope selector), if any. */
		actions?: Snippet;
	}

	let { title = 'Dashboard', actions }: Props = $props();
</script>

<header class="dashboard-header">
	<h1 class="dashboard-header__title">{title}</h1>
	<div class="dashboard-header__actions">
		{#if actions}{@render actions()}{/if}
	</div>
</header>

<style>
	.dashboard-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--space-4);
	}

	.dashboard-header__title {
		margin: 0;
		font-size: var(--font-size-x-large);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.dashboard-header__actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
</style>
