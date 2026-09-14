<script lang="ts">
	/**
	 * Raw-JSON block (extracted from `NodeDetailPanel`, ADR 2.5).
	 *
	 * The `Raw JSON` section: a heading plus a show/hide toggle that expands the
	 * node's full DTO, stringified and rendered through `ScrollView`. Pure
	 * presentation — the collapsed-by-default toggle state is local to this
	 * component (the panel root no longer tracks it).
	 */
	import type { NodeDetail } from '$lib/model/types';
	import ScrollView from '$lib/components/primitives/ScrollView.svelte';

	interface Props {
		detail: NodeDetail;
	}

	let { detail }: Props = $props();

	let showRaw = $state(false);
</script>

<section class="block">
	<div class="raw-head">
		<h4>Raw JSON</h4>
		<button type="button" class="ui-link-btn expand" onclick={() => (showRaw = !showRaw)}>
			{showRaw ? 'Hide raw JSON' : 'Show raw JSON'}
		</button>
	</div>
	{#if showRaw}
		<div class="raw">
			<ScrollView>{JSON.stringify(detail, null, 2)}</ScrollView>
		</div>
	{/if}
</section>

<style>
	/* Section chrome mirrored from the panel: `block` is shared by the steps
	   table section that still lives in `NodeDetailPanel`. */
	.block {
		margin-top: var(--space-4);
	}

	.block h4 {
		margin: 0 0 var(--space-1);
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-medium);
		color: var(--text-strong);
	}

	.raw {
		display: flex;
		flex-direction: column;
		margin: var(--space-2) 0 0;
		padding: var(--space-2);
		background: var(--background-strong);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
		font-family: var(--font-family-mono);
		font-size: var(--font-size-sm);
		color: var(--text-base);
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 28rem;
		overflow: hidden;
	}

	.raw-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.raw-head h4 {
		margin: 0;
	}
</style>
