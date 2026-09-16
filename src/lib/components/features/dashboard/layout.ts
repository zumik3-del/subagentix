/**
 * Dashboard grid geometry — the single source of truth for the free-form
 * layout (epic #462, stage 1).
 *
 * Pure constants only: no Svelte, no DOM, no `$lib/server` and no imports at
 * all, so both consumers can express themselves from here — today's CSS
 * fallback (`WidgetGrid.svelte`) and the gridstack config that lands in a later
 * stage. Keeping the numbers in one module is what stops the px values drifting
 * from the stylesheet again.
 *
 * Why these numbers: the root font-size is `--font-size-base` = 14px
 * (`src/app.css:24`, applied on `body` at `src/app.css:239`), so the
 * `grid-auto-rows: 3rem` row is 3 × 14 = 42px and the `--space-4` gap
 * (`src/app.css:37`, `1rem`) is 14px. The 6-column, 3rem-row grid replaced the
 * original 4-column/6rem one (the 6rem sizes look identical because the height
 * scale doubled with the row step), so the width fraction is now a sixth, not
 * a quarter. The breakpoints are the
 * `max-width` media queries the CSS grid already clamps at: `63.99rem` for the
 * 2-column tablet mode and `39.99rem` for the 1-column phone mode
 * (`WidgetGrid.svelte:135,147`); `64rem` is the same cutoff as
 * `--breakpoint-lg` (`src/app.css:52`) written as a minimum for the desktop
 * mode. The widget bounds also live here so size and position share one source.
 */

/** Root font size in px, `--font-size-base` (`src/app.css:24,239`). */
export const ROOT_FONT_SIZE_PX = 14;

/** Desktop grid columns. The free-form layout targets this 6-column mode only. */
export const GRID_COLUMNS = 6;

/**
 * One widget height unit is one 3rem grid row, i.e. 1 row per unit. The
 * constant exists so the future gridstack `cellHeight`/`h` mapping is explicit
 * rather than an implicit multiplier.
 */
export const ROWS_PER_HEIGHT_UNIT = 1;

/** Grid row height in rem, `grid-auto-rows` (`WidgetGrid.svelte`). */
export const GRID_ROW_HEIGHT_REM = 3;

/** Grid row height in px: 3rem × 14px root = 42px. */
export const GRID_ROW_HEIGHT_PX = GRID_ROW_HEIGHT_REM * ROOT_FONT_SIZE_PX;

/** Grid gap in rem, `--space-4` (`src/app.css:37`). */
export const GRID_GAP_REM = 1;

/** Grid gap in px: 1rem × 14px root = 14px. */
export const GRID_GAP_PX = GRID_GAP_REM * ROOT_FONT_SIZE_PX;

/** Desktop minimum width: ≥ 64rem (896px) renders the 6-column grid. */
export const GRID_DESKTOP_MIN_WIDTH_REM = 64;
export const GRID_DESKTOP_MIN_WIDTH_PX = GRID_DESKTOP_MIN_WIDTH_REM * ROOT_FONT_SIZE_PX;

/** Tablet minimum width: 40rem (560px) — the start of the 2-column mode. */
export const GRID_TABLET_MIN_WIDTH_REM = 40;
export const GRID_TABLET_MIN_WIDTH_PX = GRID_TABLET_MIN_WIDTH_REM * ROOT_FONT_SIZE_PX;

/** Tablet maximum width, `max-width: 63.99rem` (`WidgetGrid.svelte:135`). */
export const GRID_TABLET_MAX_WIDTH_REM = 63.99;

/** Phone maximum width, `max-width: 39.99rem` (`WidgetGrid.svelte:147`). */
export const GRID_PHONE_MAX_WIDTH_REM = 39.99;

/** Width is a count of equal sixth-width grid blocks (6 = full row). */
export const WIDGET_MIN_WIDTH = 1;
export const WIDGET_MAX_WIDTH = 6;

/** Height is a count of 3rem grid rows. */
export const WIDGET_MIN_HEIGHT = 1;
export const WIDGET_MAX_HEIGHT = 16;
