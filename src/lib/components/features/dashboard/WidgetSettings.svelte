<script lang="ts">
	/**
	 * Per-widget settings dialog (task #449; schema-driven in #520).
	 *
	 * Opened by the gear on a `WidgetCard` and mounted by `Dashboard`. The rows
	 * come from the registry — `widgetSettingDefs(widget.id)` in declaration
	 * order — so a widget gets its controls for free and the dialog never
	 * changes when a new setting is added. It applies immediately: a toggle
	 * calls `onChange(key, value)` at once, there is no draft and no Apply/Cancel.
	 * The shell updates its settings map optimistically and persists through the
	 * coalescing writer, surfacing a failure in `error`. A widget with no
	 * declared settings still opens the dialog and shows the `No settings yet.`
	 * placeholder.
	 *
	 * Size is drag/resize only (epic #462): the old Width/Height controls were
	 * removed in #520. Focus handling follows docs/ui-standards.md §9: dialog
	 * semantics, Escape close, a Tab trap (checkboxes are focusable), initial
	 * focus and focus return to the gear, and no markup while closed.
	 */
	import { tick } from 'svelte';
	import Icon from '$lib/components/primitives/Icon.svelte';
	import {
		widgetSettingDefs,
		type WidgetDef,
		type WidgetSettingValues
	} from '$lib/widgets/registry';
	import { resolveWidgetSettingValues } from '$lib/widgets/settings';

	interface Props {
		open: boolean;
		/** Registry entry of the widget being configured. */
		widget?: WidgetDef;
		/** This widget's current settings; missing keys resolve to their defaults. */
		settings?: WidgetSettingValues;
		/** True while the shared save writer has a request in flight. */
		saving?: boolean;
		/** Last save failure, shown inside the dialog. */
		error?: string | null;
		/** Apply one setting change (immediate; the shell persists it). */
		onChange: (key: string, value: boolean) => void;
		onClose: () => void;
	}

	let {
		open,
		widget,
		settings = {},
		saving = false,
		error = null,
		onChange,
		onClose
	}: Props = $props();

	let dialog = $state<HTMLDivElement | null>(null);
	let previouslyFocused: HTMLElement | null = null;
	let wasOpen = false;

	/** Registry-declared rows, in declaration order (`[]` -> placeholder). */
	let defs = $derived(widget ? widgetSettingDefs(widget.id) : []);
	/** Effective values: stored overrides merged with the registry defaults. */
	let values = $derived(widget ? resolveWidgetSettingValues(widget.id, settings) : {});

	$effect(() => {
		const isOpen = open && widget !== undefined;
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

	function controlId(key: string): string {
		return `${widget?.id ?? ''}-${key}`;
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

{#if open && widget}
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
					{#if defs.length === 0}
						<p class="widget-settings__empty">No settings yet.</p>
					{:else}
						<div class="widget-settings__fields">
							{#each defs as def (def.key)}
								<label class="ui-checkbox" for={controlId(def.key)}>
									<input
										class="ui-checkbox__input"
										type="checkbox"
										id={controlId(def.key)}
										checked={values[def.key]}
										onchange={(event) => onChange(def.key, event.currentTarget.checked)}
									/>
									<span class="widget-setting__text">
										<span class="widget-setting__label">{def.label}</span>
										{#if def.hint}
											<span class="widget-setting__hint">{def.hint}</span>
										{/if}
									</span>
								</label>
							{/each}
						</div>
					{/if}
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

	.widget-settings__empty {
		margin: 0;
		font-size: var(--font-size-small);
		color: var(--text-weak);
	}

	.widget-settings__fields {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	/* A labelled checkbox row: label/hint text only — the row box, alignment
	   and checkbox accent come from the shared `.ui-checkbox` primitive. */
	.widget-setting__text {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.widget-setting__label {
		font-size: var(--font-size-small);
		color: var(--text-base);
	}

	.widget-setting__hint {
		font-size: var(--font-size-xs);
		color: var(--text-weak);
	}
</style>
