<script lang="ts">
	/**
	 * Unified inferred tracker-ref control (replaces the old chip list/collapse).
	 *
	 * One mechanism wherever refs render:
	 * - 0 refs  -> nothing;
	 * - 1 ref   -> a single `#N` chip that opens the task modal;
	 * - >=2 refs -> an `N tasks` button that reveals a list of `#N` items,
	 *               each opening the task modal.
	 *
	 * When `refBase`/`onOpenTask` is absent (`onOpen` omitted) the refs stay
	 * inert text. The dropdown opens downward by default, flips up when the
	 * nearest clipping ancestor leaves no room below, and closes on Escape or
	 * an outside click. Pure presentation: callers own the refs and the
	 * open-task callback.
	 */
	interface Props {
		/** Deduplicated inferred refs to render. */
		refs: string[];
		/**
		 * Open the task-detail modal for a ref. Omitted when no tracker base is
		 * configured, so the refs render as non-interactive text.
		 */
		onOpen?: (ref: string) => void;
	}

	let { refs, onOpen }: Props = $props();

	/** Only interactive when a tracker base is configured. */
	const interactive = $derived(typeof onOpen === 'function');
	/** Whether the >=2 dropdown is open. */
	let open = $state(false);
	/** Dropdown placement: `false` opens downward, `true` flips up. */
	let dropUp = $state(false);
	let root: HTMLSpanElement | undefined = $state();
	let panel: HTMLDivElement | undefined = $state();

	function toggle(): void {
		open = !open;
	}

	function choose(ref: string): void {
		open = false;
		onOpen?.(ref);
	}

	/**
	 * Vertical bounds of the nearest ancestor that clips its overflow (the
	 * Gantt scroll frame, the page scroll region, …), so the dropdown flips
	 * against the real clip edge instead of the viewport. Falls back to the
	 * viewport when no clipping ancestor is found.
	 */
	function verticalBounds(from: HTMLElement): { top: number; bottom: number } {
		let top = 0;
		let bottom = window.innerHeight;
		for (let node = from.parentElement; node; node = node.parentElement) {
			const overflowY = getComputedStyle(node).overflowY;
			if (
				overflowY === 'hidden' ||
				overflowY === 'auto' ||
				overflowY === 'scroll' ||
				overflowY === 'clip'
			) {
				const rect = node.getBoundingClientRect();
				top = Math.max(top, rect.top);
				bottom = Math.min(bottom, rect.bottom);
				break;
			}
		}
		return { top, bottom };
	}

	// Close the dropdown on Escape or an outside pointer press (client only).
	$effect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			open = false;
			root?.querySelector<HTMLButtonElement>('[data-refs-toggle]')?.focus();
		};
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (root && target && !root.contains(target)) open = false;
		};
		document.addEventListener('keydown', onKey);
		document.addEventListener('pointerdown', onPointerDown);
		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('pointerdown', onPointerDown);
		};
	});

	// Flip the dropdown up when there is not enough room below the trigger.
	$effect(() => {
		// Recompute placement when the ref list changes while the menu is open:
		// reading `refs.length` pins the dependency (the `panel` DOM read below
		// is not reactive), so swapping refs mid-dropdown cannot leave a stale
		// `dropUp`.
		void refs.length;
		if (!open || !root || !panel) {
			dropUp = false;
			return;
		}
		const rect = root.getBoundingClientRect();
		const bounds = verticalBounds(root);
		const need = panel.offsetHeight + 8;
		const spaceBelow = bounds.bottom - rect.bottom;
		const spaceAbove = rect.top - bounds.top;
		dropUp = spaceBelow < need && spaceAbove > spaceBelow;
	});
</script>

{#if interactive}
	{#if refs.length === 1}
		<button
			type="button"
			class="ui-chip ui-chip--link"
			title={`Task #${refs[0]} (inferred tracker link)`}
			aria-label={`Task #${refs[0]} (inferred tracker link)`}
			onclick={() => onOpen?.(refs[0])}>{`#${refs[0]}`}</button
		>
	{:else if refs.length > 1}
		<span class="tracker-refs" bind:this={root}>
			<button
				type="button"
				class="ui-chip ui-chip--toggle"
				data-refs-toggle
				aria-expanded={open}
				title="Show all inferred tracker links"
				onclick={toggle}
			>
				{refs.length} tasks
			</button>
			{#if open}
				<div class="refs-menu" class:refs-menu--up={dropUp} bind:this={panel}>
					{#each refs as ref (ref)}
						<button
							type="button"
							class="ui-chip ui-chip--link"
							title={`Task #${ref} (inferred tracker link)`}
							aria-label={`Task #${ref} (inferred tracker link)`}
							onclick={() => choose(ref)}
						>
							#{ref}
						</button>
					{/each}
				</div>
			{/if}
		</span>
	{/if}
{:else}
	{#each refs as ref (ref)}
		<span
			class="ui-chip"
			title={`Task #${ref} (inferred tracker link)`}
			aria-label={`Task #${ref} (inferred tracker link)`}>{`#${ref}`}</span
		>
	{/each}
{/if}

<style>
	.tracker-refs {
		position: relative;
		display: inline-flex;
		align-items: center;
	}

	.refs-menu {
		position: absolute;
		top: calc(100% + var(--space-1));
		right: 0;
		z-index: 20;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-1);
		padding: var(--space-1);
		background: var(--background-strong);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-md);
		pointer-events: auto;
	}

	.refs-menu--up {
		top: auto;
		bottom: calc(100% + var(--space-1));
	}
</style>
