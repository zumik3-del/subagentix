<script lang="ts">
	/**
	 * Dashboard shell root (dashboard Phase 3, task #404).
	 *
	 * Owns the selected-widget set (seeded from settings via the page loader)
	 * and composes the header + responsive grid. The header's `actions` slot
	 * hosts the global period/project selector (#415) and the "Widgets" picker
	 * button (#414). The filter is a prop with a default so the shell renders
	 * standalone; the landing page supplies it from URL state (falling back to
	 * the stored preference) and receives every selector change through
	 * `onFilterChange` — the shell itself never persists the filter (#457). Each
	 * selected widget mounts lazily and fetches its own data through the grid's
	 * registry loaders, re-fetching whenever the filter prop changes (tasks
	 * #410/#415).
	 *
	 * Since #449/#520 the shell also owns the per-widget settings target: a gear
	 * on a card opens one schema-driven `WidgetSettings` dialog whose changes
	 * apply optimistically and persist through a coalescing writer (separate
	 * from the drag/resize placements writer). The settings map is threaded to
	 * the grid, host, shell and fetch so a toggle re-fetches the widget.
	 *
	 * Since #492 the shell provides the detail-overlay controls through context
	 * and mounts the single `DetailHost`; widget bodies open a detail without a
	 * threaded callback and the page keeps owning the URL state.
	 */
	import type { DashboardFilter } from '$lib/model/dashboard';
	import type { ToolCallDetail } from '$lib/model/tool-errors';
	import Icon from '$lib/components/primitives/Icon.svelte';
	import {
		findWidgetDef,
		resolvePlacements,
		type WidgetId,
		type WidgetPlacement,
		type WidgetSettingValues
	} from '$lib/widgets/registry';
	import DashboardHeader from './DashboardHeader.svelte';
	import DetailHost from './DetailHost.svelte';
	import FilterSelector from './FilterSelector.svelte';
	import WidgetGrid from './WidgetGrid.svelte';
	import WidgetSettings from './WidgetSettings.svelte';
	import WidgetsModal from './WidgetsModal.svelte';
	import { detailTargetFor, setDetailControls, type DetailTarget } from './detail';
	import { DEFAULT_FILTER, type FilterOption } from './filter';
	import { createCoalescingWriter, saveDashboardWidgetSettings, saveDashboardWidgets } from './save';

	interface Props {
		/** Selected widget placements, already normalised by the settings store. */
		widgets: readonly WidgetPlacement[];
		/** Active global filter; the page derives it from `?period=&scope=`. */
		filter?: DashboardFilter;
		/** Global refresh counter; a change refetches every active widget. */
		refreshToken?: number;
		/**
		 * Persisted per-widget settings by widget id, seeded by the page loader
		 * (task #520). Defaults to `{}` so the shell still renders standalone.
		 */
		settings?: Record<WidgetId, WidgetSettingValues>;
		/** Directory options for the scope selector (no `All projects` entry). */
		scopes?: readonly FilterOption[];
		/** Selector callback; the page turns it into a `goto` URL update. */
		onFilterChange?: (filter: DashboardFilter) => void;
		/**
		 * Tool-call detail overlay target (`?toolErrors=` or `?toolCalls=`);
		 * `null` while closed. The page owns the URL state and passes it down
		 * (tasks #481/#484).
		 */
		toolDetail?: ToolCallDetail | null;
		/** Opens (`detail`) or closes (`null`) the tool-call detail overlay. */
		onToolDetailChange?: (detail: ToolCallDetail | null) => void;
	}

	let {
		widgets,
		filter = DEFAULT_FILTER,
		refreshToken = 0,
		// Standalone default (no loader): an empty map is "every widget at its
		// registry defaults" once the per-widget dialog resolves its own values.
		settings = {} as Record<WidgetId, WidgetSettingValues>,
		scopes = [],
		onFilterChange,
		toolDetail = null,
		onToolDetailChange
	}: Props = $props();

	/**
	 * Detail-overlay controls for every descendant widget body (task #492).
	 * A body calls `openDetail(target)` / `closeDetail()` from context, so the
	 * callback no longer threads through the grid, host and shell. The URL state
	 * itself stays with the page (the shell only forwards it), keeping the
	 * `?toolErrors=`/`?toolCalls=` deep-link contract unchanged.
	 */
	setDetailControls({
		openDetail: (target: DetailTarget) =>
			onToolDetailChange?.({ tool: target.tool, mode: target.mode }),
		closeDetail: () => onToolDetailChange?.(null)
	});

	/** Registry target for the single `DetailHost` (or `null` while closed). */
	let detailTarget = $derived(
		toolDetail === null ? null : detailTargetFor(toolDetail.tool, toolDetail.mode)
	);

	// Applied selection: starts from the loader, and a save replaces it with
	// the normalised placements the settings API returned, so the grid
	// re-renders without a full reload (tasks #414/#449). A later loader refresh
	// still wins until the next save.
	let applied = $state<WidgetPlacement[] | null>(null);
	// Applied per-widget settings (task #520): starts from the loader and a save
	// replaces it with the server-normalised map. A failure restores the last
	// server-confirmed map, falling back to the loader baseline while none exists.
	let appliedSettings = $state<Record<WidgetId, WidgetSettingValues> | null>(null);
	/** Last server-confirmed settings map; `null` means the loader baseline. */
	let lastSavedSettings = $state<Record<WidgetId, WidgetSettingValues> | null>(null);
	let pickerOpen = $state(false);
	/** Widget whose settings are open, or `null` while closed. */
	let settingsId = $state<WidgetId | null>(null);
	let settingsError = $state<string | null>(null);
	let settingsSaving = $state(false);

	// Registry order + dedupe + clamp, so the grid always matches the picker.
	let placements = $derived(resolvePlacements(applied ?? widgets));
	/** Effective settings map: optimistic edits, else the loader baseline. */
	let currentSettings = $derived(appliedSettings ?? settings);
	let settingsWidget = $derived(settingsId === null ? undefined : findWidgetDef(settingsId));
	let settingsValues = $derived(settingsId === null ? {} : (currentSettings[settingsId] ?? {}));

	// The settings writer is separate from the placements writer (task #520):
	// toggling a setting only PUTs `dashboardWidgetSettings` and restores the
	// last server-confirmed settings map on failure. Drag/resize never touches
	// this path.
	const settingsWriter = createCoalescingWriter<Record<WidgetId, WidgetSettingValues>>(
		async (next) => {
			try {
				const saved = await saveDashboardWidgetSettings(next);
				lastSavedSettings = saved;
				appliedSettings = saved;
				settingsError = null;
			} catch (cause) {
				appliedSettings = lastSavedSettings;
				settingsError = cause instanceof Error ? cause.message : String(cause);
			} finally {
				settingsSaving = false;
			}
		}
	);

	// Drag/resize path (epic #462, stage 3): one PUT per settled gesture, coalesced
	// across rapid ones. The response is discarded — it is never fed back as
	// `applied`, so it cannot re-render the grid; a rejected PUT leaves
	// `applied` and the live gridstack layout untouched. `applied` is advanced from
	// the reported layout (not the response) so the picker and the next save see it.
	const layoutWriter = createCoalescingWriter<readonly WidgetPlacement[]>(async (next) => {
		try {
			await saveDashboardWidgets(next);
		} catch {
			// Silent by design: the on-screen layout must survive a failed write.
		}
	});

	function onLayoutChange(next: readonly WidgetPlacement[]): void {
		applied = [...next];
		layoutWriter.push(next);
	}

	function onApply(next: readonly WidgetPlacement[]): void {
		applied = [...next];
		pickerOpen = false;
	}

	function onWidgetSettings(id: WidgetId): void {
		settingsId = id;
		settingsError = null;
	}

	function onSettingsChange(key: string, value: boolean): void {
		const id = settingsId;
		if (id === null) return;
		const current = currentSettings[id] ?? {};
		const next = { ...currentSettings, [id]: { ...current, [key]: value } };
		appliedSettings = next;
		settingsError = null;
		settingsSaving = true;
		settingsWriter.push(next);
	}

	function closeSettings(): void {
		settingsId = null;
		settingsError = null;
	}
</script>

<main class="dashboard">
	<DashboardHeader>
		{#snippet actions()}
			<FilterSelector {filter} {scopes} onChange={onFilterChange} />
			<button
				type="button"
				class="ui-icon-btn"
				onclick={() => (pickerOpen = true)}
				aria-label="Widgets"
				title="Widgets"
				aria-haspopup="dialog"
			>
				<Icon name="gear" />
			</button>
			<!-- Entry point to the read-only files viewer (epic #775, spec §7). -->
			<a class="ui-btn" href="/files" title="Files" aria-label="Files">
				<Icon name="files" />
				Files
			</a>
		{/snippet}
	</DashboardHeader>

	{#if placements.length === 0}
		<p class="dashboard__empty">
			No widgets selected. Use the gear button to add widgets to your dashboard.
		</p>
	{:else}
		<WidgetGrid
			{placements}
			{filter}
			{refreshToken}
			settings={currentSettings}
			onWidgetSettings={onWidgetSettings}
			{onLayoutChange}
		/>
	{/if}
</main>

<WidgetsModal
	open={pickerOpen}
	selected={placements}
	onApply={onApply}
	onClose={() => (pickerOpen = false)}
/>

<WidgetSettings
	open={settingsId !== null}
	widget={settingsWidget}
	settings={settingsValues}
	saving={settingsSaving}
	error={settingsError}
	onChange={onSettingsChange}
	onClose={closeSettings}
/>

<DetailHost target={detailTarget} {filter} {scopes} />

<style>
	/* Side padding matches the turn page (`/sessions/[id]`): `--space-4`. */
	.dashboard {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
		padding: var(--space-6) var(--space-4) var(--space-12);
	}

	.dashboard__empty {
		margin: 0;
		padding: var(--space-12) var(--space-8);
		border: 1px dashed var(--border-weak-base);
		border-radius: var(--radius-lg);
		text-align: center;
		color: var(--text-weak);
	}
</style>
