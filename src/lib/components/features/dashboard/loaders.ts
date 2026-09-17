/**
 * Per-widget code-split loaders (dashboard Phase 3/4, tasks #410-#413).
 *
 * The shell and the grid stay ignorant of the concrete widget modules; this map
 * is the single registration point. Phase 3 wired every registered widget to
 * the generic `WidgetBody` placeholder; Phase 4 swapped each entry for that
 * widget's body. Tasks #411/#412 registered the two time-series widgets and the
 * KPI/distribution/bar widgets; #413 registers `top-tools`, completing the set.
 */
import type { WidgetLoaders } from './widget';

export const WIDGET_LOADERS: WidgetLoaders = {
	kpi: () => import('./KpiWidget.svelte'),
	'sessions-per-day': () => import('./SessionsPerDayWidget.svelte'),
	'cost-per-day': () => import('./CostPerDayWidget.svelte'),
	'top-tools': () => import('./TopToolsWidget.svelte'),
	'agent-distribution': () => import('./AgentDistributionWidget.svelte'),
	'top-projects': () => import('./TopProjectsWidget.svelte')
};
