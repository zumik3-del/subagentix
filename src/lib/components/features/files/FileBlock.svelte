<script lang="ts">
	/**
	 * One collapsible block on `/files` (epic #775, spec §7).
	 *
	 * The global block starts expanded and project blocks collapsed; a collapsed
	 * block renders no file rows. The header is a `<button>` carrying
	 * `aria-expanded`/`aria-controls` (the panel id stays present so the
	 * reference resolves). `available: false` (missing root) yields no groups and
	 * a "Directory not found" header state.
	 */
	import type { FileBlock, FileContent } from '$lib/model/files';
	import { untrack } from 'svelte';
	import TreeIcon from '$lib/components/primitives/TreeIcon.svelte';
	import FileGroupView from './FileGroup.svelte';

	interface Props {
		block: FileBlock;
		load: (block: string, path: string) => Promise<FileContent>;
	}

	let { block, load }: Props = $props();

	// Default open state is fixed at mount (spec §7): the global block expands,
	// project blocks start collapsed.
	let open = $state(untrack(() => block.scope === 'global'));

	let panelId = $derived(`files-panel-${block.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`);
	let fileCount = $derived(
		block.groups.reduce((total, group) => total + group.files.length, 0)
	);
</script>

<section class="files-block ui-card">
	<h2 class="files-block__heading">
		<button
			type="button"
			class="files-block__toggle"
			aria-expanded={open}
			aria-controls={panelId}
			onclick={() => (open = !open)}
		>
			<TreeIcon name="chevron" expanded={open} />
			<span class="files-block__name">{block.name}</span>
			<span class="files-block__worktree muted">{block.worktree}</span>
			<span class="files-block__meta">
				{#if block.available}
					{fileCount} file{fileCount === 1 ? '' : 's'}
				{:else}
					Directory not found
				{/if}
			</span>
		</button>
	</h2>

	<div id={panelId} class="files-block__panel">
		{#if open && block.available}
			{#each block.groups as group (group.kind)}
				<FileGroupView {group} blockId={block.id} {load} />
			{/each}
		{/if}
	</div>
</section>

<style>
	.files-block {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.files-block__heading {
		margin: 0;
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-medium);
	}

	.files-block__toggle {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		padding: 0;
		background: none;
		border: none;
		color: var(--text-strong);
		font: inherit;
		font-size: var(--font-size-base);
		text-align: left;
		cursor: pointer;
	}

	.files-block__name {
		flex: none;
	}

	.files-block__worktree {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-family-mono);
		font-size: var(--font-size-xs);
	}

	.files-block__meta {
		margin-left: auto;
		flex: none;
		font-size: var(--font-size-xs);
		font-variant-numeric: tabular-nums;
		color: var(--text-weak);
	}

	.files-block__panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
</style>
