/**
 * Lazy-mount contract for dashboard widgets (dashboard Phase 3, task #409).
 *
 * A widget body is code-split: `WidgetHost` calls a loader only once its host
 * scrolled into view. The loader is the Vite dynamic-import boundary, so no
 * widget module is pulled into the SSR graph or the initial client bundle
 * until then. Kept free of `$lib/server` / DOM so both SSR and client import
 * it.
 */
import type { Component } from 'svelte';
import type { DashboardFilter, WidgetDataMap } from '$lib/model/dashboard';
import type { WidgetDef, WidgetId, WidgetSettingValues } from '$lib/widgets/registry';

/**
 * Props `WidgetHost` forwards to the shell for one mounted widget (tasks
 * #410/#491): the registry descriptor, the shared `filter`, the global
 * `refreshToken`, this widget's resolved settings and the shell-owned callbacks.
 * Every v1 body is a pure {@link WidgetRenderProps} renderer now, so these are
 * the shell's inputs — a body never reaches for global shell state; it reads
 * its typed payload from `WidgetShell`, which fetches `widgetSource(widget.id)`
 * and refetches with `?refresh=1` when `refreshToken` changes (global refresh)
 * or the card refresh control fires (this widget only).
 */
export interface WidgetBodyProps {
	/** Registry entry for this body; supplies the endpoint and card title. */
	widget: WidgetDef;
	/** Active global filter (period + scope), shared by every widget. */
	filter: DashboardFilter;
	/** Global refresh counter; a change refetches this widget with `refresh=1`. */
	refreshToken: number;
	/**
	 * This widget's resolved settings; the shell appends the `w.<key>=1|0`
	 * params from it. An empty map means the widget declares no settings.
	 */
	settings: WidgetSettingValues;
	/**
	 * Opens this widget's settings modal (task #449/#520). The grid supplies it
	 * for every body; omitted only when the shell has no settings hook.
	 */
	onSettings?: () => void;
}

/**
 * Props a migrated, pure widget body receives from `WidgetShell` (task #490).
 *
 * The shell owns the fetch and the `WidgetCard` chrome; the body is content-only
 * and reads its typed payload straight from {@link WidgetDataMap}. The callbacks
 * are forwarded so an interactive body (e.g. a clickable table) can still open
 * the shell-owned dialogs.
 */
export interface WidgetRenderProps<K extends WidgetId = WidgetId> {
	/** This widget's typed payload; never `null` while the shell renders the body. */
	data: WidgetDataMap[K];
	/** Active global filter, forwarded from the shell. */
	filter: DashboardFilter;
	/** Opens this widget's settings modal (forwarded from the shell). */
	onSettings?: () => void;
}

/**
 * A pure widget body for one id: `{ data }` in, rendered content out.
 *
 * The open `Record<string, unknown>` member is the descriptor `params` slot
 * (task #491): a shared parameterized body (e.g. `DayTableWidget`) declares its
 * own extra props — `label`/`formatValue` — and the shell spreads the
 * descriptor's params through. `data` and `filter` stay typed by `K`, so the
 * id-to-payload contract is unchanged.
 */
export type WidgetRenderer<K extends WidgetId = WidgetId> = Component<
	WidgetRenderProps<K> & Record<string, unknown>
>;

/**
 * A dynamically imported widget body. Which id maps to which body is a runtime
 * pairing (the registry's `load` and its key agree by construction), so the
 * component type is intentionally loose at this boundary; each body still
 * declares its own typed props — the legacy {@link WidgetBodyProps} surface or
 * the pure {@link WidgetRenderProps} one. `any` is the only prop record both
 * contracts are assignable to, and it is confined to this runtime boundary.
 */
export type WidgetComponent = Component<any>;

/** Dynamic import of one widget body; Vite code-splits the target module. */
export type WidgetLoader = () => Promise<{ default: WidgetComponent }>;

/**
 * Per-widget lifecycle state the card chrome renders. Produced by the data
 * hook (task #410) and accepted by `WidgetCard` (only `ready` shows the body).
 */
export type WidgetStatus = 'loading' | 'ready' | 'error' | 'empty';
