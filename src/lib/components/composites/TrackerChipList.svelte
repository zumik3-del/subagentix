<script lang="ts">
	/**
	 * Inferred tracker-ref chip list (promoted from the `Gantt` snippet, ADR 3.3).
	 *
	 * Renders the refs as inert `.ui-chip` text, or as modal-trigger buttons when
	 * the optional `onOpen` callback is supplied, followed by the `N tasks`
	 * collapse expander. Pure presentation: the `Gantt` root owns the expansion
	 * state and the open-task callback and passes them down.
	 *
	 * The inert branch is authored first (`{#if !onOpen}`) so the SSR block
	 * anchor comments stay byte-identical to the pre-extraction snippet.
	 */
	import type { CollapsedTrackerRefs } from '$lib/model/tracker';

	interface Props {
		/** Refs to render, already resolved for the collapsed/expanded state. */
		refs: string[];
		/** Collapsed display view of the node's full ref list. */
		chips: CollapsedTrackerRefs;
		/** Whether the ref list is currently expanded. */
		expanded: boolean;
		/** Toggle the collapsed/expanded state (owned by the parent). */
		onToggle: () => void;
		/**
		 * Open the task-detail modal for an inferred ref. Omitted when no tracker
		 * base is configured, so the chips render as non-interactive text.
		 */
		onOpen?: (ref: string) => void;
	}

	let { refs, chips, expanded, onToggle, onOpen }: Props = $props();
</script>

{#each refs as ref (ref)}
	{#if !onOpen}
		<span
			class="ui-chip"
			title={`Task #${ref} (inferred tracker link)`}
			aria-label={`Task #${ref} (inferred tracker link)`}>{`#${ref}`}</span
		>
	{:else}
		<button
			type="button"
			class="ui-chip ui-chip--link"
			title={`Task #${ref} (inferred tracker link)`}
			aria-label={`Task #${ref} (inferred tracker link)`}
			onclick={() => onOpen?.(ref)}>{`#${ref}`}</button
		>
	{/if}
{/each}
{#if chips.hiddenCount > 0}
	<button
		type="button"
		class="ui-chip ui-chip--toggle"
		onclick={onToggle}
		title="Show all inferred tracker links"
	>
		{expanded ? 'Show fewer' : chips.expanderLabel}
	</button>
{/if}
