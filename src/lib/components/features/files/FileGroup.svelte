<script lang="ts">
	/**
	 * One ordered file group inside an open `/files` block (epic #775, spec §7).
	 *
	 * The group's kind/label renders as a `.ui-badge` heading; its files are one
	 * `FileRow` each.
	 */
	import type { FileContent, FileGroup } from '$lib/model/files';
	import FileRow from './FileRow.svelte';

	interface Props {
		group: FileGroup;
		blockId: string;
		load: (block: string, path: string) => Promise<FileContent>;
	}

	let { group, blockId, load }: Props = $props();
</script>

<section class="files-group">
	<h3 class="files-group__heading">
		<span class="ui-badge">{group.label}</span>
	</h3>
	<ul class="files-group__list">
		{#each group.files as file (file.path)}
			<FileRow {file} {blockId} {load} />
		{/each}
	</ul>
</section>

<style>
	.files-group {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.files-group__heading {
		margin: 0;
		font-weight: var(--font-weight-medium);
	}

	.files-group__list {
		margin: 0;
		padding: 0;
		list-style: none;
	}
</style>
