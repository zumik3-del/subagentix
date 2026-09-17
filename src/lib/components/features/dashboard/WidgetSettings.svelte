<script lang="ts">
	/**
	 * Per-widget size settings dialog (task #449).
	 *
	 * Opened by the gear on a `WidgetCard` and mounted by `Dashboard`. It applies
	 * immediately: a Width/Height change calls `onChange` at once — there is no
	 * draft and no Apply/Cancel. The shell patches the placements optimistically
	 * (so the grid re-lays out instantly) and persists through the coalescing
	 * writer, surfacing a failure in `error`; the size controls stay enabled
	 * while a save is in flight so rapid `+`/`−` clicks coalesce instead of
	 * losing the last one. Focus handling follows docs/ui-standards.md §9: dialog
	 * semantics, Escape close, a Tab trap, initial focus and focus return to the
	 * gear, and no markup while closed.
	 */
	import { tick } from 'svelte';
	import Icon from '$lib/components/primitives/Icon.svelte';
	import { WIDGET_MAX_HEIGHT, WIDGET_MAX_WIDTH } from '$lib/widgets/registry';
	import type { WidgetDef, WidgetPlacement } from '$lib/widgets/registry';
	import type { WidgetSizePatch } from './widget';

	interface Props {
		open: boolean;
		/** Registry entry of the widget being sized. */
		widget?: WidgetDef;
		/** Current placement of that widget; the controls edit it. */
		placement?: WidgetPlacement;
		/** True while the shared save writer has a request in flight. */
		saving?: boolean;
		/** Last save failure, shown inside the dialog. */
		error?: string | null;
		/** Apply one size change (immediate; the shell persists it). */
		onChange: (patch: WidgetSizePatch) => void;
		onClose: () => void;
	}

	let {
		open,
		widget,
		placement,
		saving = false,
		error = null,
		onChange,
		onClose
	}: Props = $props();

	let dialog = $state<HTMLDivElement | null>(null);
	let previouslyFocused: HTMLElement | null = null;
	let wasOpen = false;

	/**
	 * Width options derived from the shared bound (`WIDGET_MAX_WIDTH`), so the
	 * select can never disagree with the grid's column count. The last option is
	 * labelled "(full)" — the row span is `GRID_COLUMNS` sixth-width blocks.
	 */
	const widthOptions = Array.from({ length: WIDGET_MAX_WIDTH }, (_, index) => index + 1);

	$effect(() => {
		const isOpen = open && widget !== undefined && placement !== undefined;
		if (isOpen && !wasOpen) {
			wasOpen = true;
			previouslyFocused =
				typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
			void tick().then(() => dialog?.focus());
		} else if (!isOpen && wasOpen) {
			wasOpen = false;
			previouslyFocused?.focus();
		}
	});

	function setWidth(value: string): void {
		onChange({ width: Number(value) });
	}

	function stepHeight(delta: number): void {
		if (!placement) return;
		onChange({ height: placement.height + delta });
	}

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

{#if open && widget && placement}
	<div class="ui-modal">
		<button
			type="button"
			class="ui-modal__backdrop"
			aria-label={`Close ${widget.title} settings`}
			onclick={onClose}
		></button>
		<div
			class="ui-modal__dialog widget-settings-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="widget-settings-title"
			tabindex="-1"
			bind:this={dialog}
			onkeydown={onDialogKeydown}
		>
			<header class="ui-modal__head">
				<h2 class="ui-modal__title" id="widget-settings-title">{widget.title}</h2>
				<p class="widget-settings__sub">Widget settings</p>
				<button
					type="button"
					class="ui-icon-btn"
					aria-label={`Close ${widget.title} settings`}
					onclick={onClose}
				>
					<Icon name="close" />
				</button>
			</header>

			<div class="ui-modal__body">
				<div class="ui-modal__content" aria-busy={saving}>
					{#if error}
						<p class="widget-settings__error" aria-live="polite">{error}</p>
					{/if}
					<div class="widget-settings__fields">
						<span class="widget-field">
							<label class="widget-field__label" for={`width-${widget.id}`}>Width</label>
							<select
								id={`width-${widget.id}`}
								class="widget-select"
								value={String(placement.width)}
								onchange={(event) => setWidth(event.currentTarget.value)}
							>
								{#each widthOptions as option (option)}
									<option value={String(option)}>
										{option} block{option === 1 ? '' : 's'}{option === WIDGET_MAX_WIDTH
											? ' (full)'
											: ''}
									</option>
								{/each}
							</select>
						</span>

						<span class="widget-field">
							<span class="widget-field__label" id={`height-${widget.id}`}>Height</span>
							<span class="widget-stepper" role="group" aria-labelledby={`height-${widget.id}`}>
								<button
									type="button"
									class="widget-step"
									aria-label={`Decrease ${widget.title} height`}
									disabled={placement.height <= widget.minHeight}
									onclick={() => stepHeight(-1)}
								>
									−
								</button>
								<span class="widget-step__value" aria-live="polite">{placement.height}</span>
								<button
									type="button"
									class="widget-step"
									aria-label={`Increase ${widget.title} height`}
									disabled={placement.height >= WIDGET_MAX_HEIGHT}
									onclick={() => stepHeight(1)}
								>
									+
								</button>
							</span>
						</span>
					</div>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Size only — shape/behavior come from the global `.ui-modal` contract. */
	.widget-settings-dialog {
		width: min(22rem, calc(100vw - 2rem));
	}

	/* Secondary text: right-aligned element of the single-line header row. */
	.widget-settings__sub {
		margin: 0;
		margin-inline-start: auto;
		align-self: flex-start;
		font-size: var(--font-size-small);
		color: var(--text-weak);
		text-align: right;
		white-space: nowrap;
	}

	.widget-settings__error {
		margin: 0 0 var(--space-3);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-danger-border);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-small);
		color: var(--color-danger-strong);
	}

	.widget-settings__fields {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.widget-field {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.widget-field__label {
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}

	.widget-select {
		padding: var(--space-1) var(--space-2);
		background: var(--surface-base);
		color: var(--text-strong);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
		font: inherit;
		font-size: var(--font-size-small);
	}

	.widget-stepper {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
	}

	.widget-step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--space-5);
		height: var(--space-5);
		padding: 0;
		background: var(--surface-raised-base);
		color: var(--text-base);
		border: 1px solid var(--border-weak-base);
		border-radius: var(--radius-sm);
		font: inherit;
		line-height: 1;
		cursor: pointer;
	}

	.widget-step:hover:not(:disabled) {
		background: var(--surface-raised-base-hover);
		color: var(--text-strong);
	}

	.widget-step:disabled {
		cursor: default;
		color: var(--text-weaker);
	}

	.widget-step__value {
		min-width: 1.5ch;
		text-align: center;
		font-size: var(--font-size-small);
		font-variant-numeric: tabular-nums;
	}
</style>
