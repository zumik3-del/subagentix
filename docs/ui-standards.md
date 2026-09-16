# UI standards — the subagentix UI contract

Single contract for the browser UI: layout, tokens, primitives, component
layering, and the tests that guard them. It is the document referenced by
`src/app.css`, the component headers and `AGENTS.md`.

**Status:** active. Behaviour-preserving refactor landed on `dev`; this file was
un-ignored when re-established, so the rules the code claims to follow are
reviewable.

---

## Scope & precedence

- This document governs the subagentix UI under `src/routes/**` and
  `src/lib/components/**`.
- `src/app.css` is the **single source of truth** for design tokens and shared
  `.ui-*` primitive classes. A component must not redefine a token or a
  primitive; it consumes them.
- Components follow the layer rules in [§10](#10-layer--component-conventions).
  Where a rule here and a legacy comment disagree, this file and the guarding
  suite ([§12](#12-verification-map)) win.
- No Tailwind, no UI library, no new runtime dependency — **one documented
  exception:** the `uplot` time-series chart library, justified in
  [§2](#2-color--tokens). Plain CSS custom properties only.

---

## 1. Layout & spacing

- **4px spacing scale.** Spacing tokens `--space-1 … --space-12` are a 4px
  scale (`0.25rem … 3rem`), declared in `src/app.css:33-42`. Use the tokens, not
  raw `px`/`rem` values.
- **Full-viewport shell.** The app shell is a two-column grid
  (`grid-template-columns: var(--sidebar-width) minmax(0, 1fr)`) with
  `height`/`min-height: 100dvh`; the sidebar column is `position: sticky`
  (`src/routes/+layout.svelte:95-111`). `--sidebar-width` is `20rem`
  (`src/app.css:51`).
- **No centered max-width container.** List and session pages must not wrap
  content in a `max-width: 64rem` container or center it with `margin: auto`
  (guarded by `pages.suite.ts`, tests "list + session pages are not centered in
  a max-width container" and "layout source renders the full-viewport sidebar
  grid + narrow toggle").
- **Narrow viewport.** Below `--breakpoint-lg` (`64rem`, `src/app.css:52`) the
  shell collapses to one column (`@media (max-width: 63.99rem)`,
  `src/routes/+layout.svelte:136`) and the sidebar becomes an off-canvas overlay
  (`fixed`, `translateX(-100%)`, `visibility: hidden`) re-enabled by
  `.shell.sidebar-open` (`src/routes/+layout.svelte:141-160`).
- Radii (`--radius-xs … --radius-full`), shadows (`--shadow-xs/md/lg`) and
  `--sidebar-width` are declared in `src/app.css:44-63`.

### Dashboard widget grid

The landing dashboard lays its widgets out on a declarative CSS grid
(`WidgetGrid.svelte:54-140`); sizing is data, not inline `grid-template`.

- **Desktop: 4 equal columns, 6rem rows.** `grid-template-columns:
  repeat(4, minmax(0, 1fr))`, `grid-auto-rows: 6rem`, `grid-auto-flow: row
  dense` (`WidgetGrid.svelte:55-64`). `row dense` lets a short widget backfill
  the gap beside a taller one.
- **Per-widget placement.** Each `WidgetPlacement` carries `width` (1–4
  quarter-width blocks) and `height` (`minHeight`–8 rows, see
  [Widget sizing & overflow](#widget-sizing--overflow)); the grid item emits them as
  `data-w`/`data-h` (`WidgetGrid.svelte:48`) and numeric attribute selectors
  map them to `grid-column: span N` / `grid-row: span N`
  (`WidgetGrid.svelte:71-117`). Width `4` is a full row.
- **Breakpoint clamps.** `≤64rem` (`max-width: 63.99rem`) drops to 2 columns
  and clamps `data-w="3"`/`data-w="4"` to `span 2`; `≤40rem`
  (`max-width: 39.99rem`) drops to 1 column and forces every item to
  `grid-column: 1 / -1` regardless of `data-w` (`WidgetGrid.svelte:119-140`).
  Height spans stay valid at every breakpoint.
- **Bounds and defaults** live in the registry: `WIDGET_MIN_WIDTH`/`MAX_WIDTH`
  (1/4) and `WIDGET_MIN_HEIGHT`/`MAX_HEIGHT` (1/8)
  (`src/lib/widgets/registry.ts:27-31`); each `WidgetDef` also carries its own
  default `width`/`height` and a per-widget `minHeight`
  (`registry.ts:89-150`). `clampWidth`/`clampHeight` round and clamp to the
  global bounds, mapping a non-finite value to the global minimum
  (`registry.ts:34-43`); `clampWidgetHeight(id, value)` additionally raises the
  result to that widget's own `minHeight`, so the effective height range is
  `[minHeight, 8]` (`registry.ts:50-52`).
- **Refresh control.** `WidgetCard` renders an optional `.ui-icon-btn` refresh
  button whose icon spins while a fetch is in flight
  (`class:is-spinning={refreshing || status === 'loading'}`,
  `WidgetCard.svelte:43-55`); the spin is CSS-only keyframes
  (`widget-refresh-spin`, `WidgetCard.svelte:119-127`) and is suppressed under
  `prefers-reduced-motion: reduce` (`WidgetCard.svelte:129-133`).

### Widget sizing & overflow

The contract the grid, the registry and the widget bodies share (task #444):
how tall a body actually is, how far a widget may shrink, and what a too-small
card does with content that no longer fits.

- **Row geometry.** Rows are `6rem` and the column gap is `--space-4` (1rem)
  (`WidgetGrid.svelte:57-60`), so a placement of `h` rows spans
  `6h + (h − 1)` = `7h − 1rem`. The card chrome consumes `4.25rem`: the
  `--space-4` (1rem) padding top + bottom (`src/app.css:601`), the `--space-6`
  (1.5rem) header (`WidgetCard.svelte:97`) and the `--space-3` (0.75rem)
  header↔body gap (`WidgetCard.svelte:87`). The usable body height for a
  placement of `h` rows is therefore **`7h − 5.25rem`**.
- **Per-widget minimum heights.** `minHeight` is part of each `WidgetDef`
  (`registry.ts:74,89-150`); a short widget is never rendered broken, its
  persisted height is raised instead.

  | Widget | `minHeight` |
  |---|---|
  | `top-projects` | 1 |
  | `top-tools` | 2 |
  | `kpi` | 2 |
  | `agent-distribution` | 2 |
  | `sessions-per-day` | 3 |
  | `cost-per-day` | 3 |

  The height range is `[minHeight, WIDGET_MAX_HEIGHT]` (`8`).
  `clampWidgetHeight(id, value)` = `max(def.minHeight, clampHeight(value))`
  (`registry.ts:50-52`) and is applied wherever placements are resolved: the
  registry `resolvePlacements` (`registry.ts:207-223`), the settings API
  `normaliseDashboardWidgets` → `resolvePlacements` (`settings.ts:142-179`) and
  the picker `toggleWidgetSelection`/`updatePlacement`
  (`picker.ts:18-39`). The picker's height stepper disables `−` at `minHeight`
  and `+` at `WIDGET_MAX_HEIGHT` (`WidgetsModal.svelte:208,220`).
- **Silent whole-row truncation.** A body that does not fit drops whole rows —
  no `+N more` affordance, no fade, no inner scrollbar. Truncation is silent by
  design; the card body's `overflow: hidden` (on both the card and the body,
  `WidgetCard.svelte:89,114`) is the hard guarantee that a body can never paint
  past the rounded contour, even mid-measurement.
- **Row budget = what the measured height holds.** `rowsThatFit` returns
  `floor(available / rowHeight)`, clamped to `[min, total]`, and returns the
  floor (never `NaN`/`Infinity`/a fractional row) when the box is not laid out
  yet (`fit.ts:38-49`). `useRowFit` measures the clipped list container and its
  first real row with one `ResizeObserver`; it reports the full list until the
  first client measurement, so SSR and hydration render every row and the trim
  lands after mount (`fit.svelte.ts:39-40,61-71`). The budget **grows with the
  card up to the rows the payload supplied** — the payload is the ceiling, not a
  fixed cap.
- **Per-body behaviour.** `BarChart` slices to the measured budget; its `limit`
  no longer defaults to `8` but to every supplied row, and the bar scale is
  computed from the untrimmed rows so resizing never re-scales the bars
  (`BarChart.svelte:54,60-72`). `TopProjectsWidget` leaves `limit` unset and
  `TopToolsWidget` passes `limit={bars.length}`, so both feed all API rows
  (`TopProjectsWidget.svelte:51`, `TopToolsWidget.svelte:51`). `DonutChart`
  shrinks the ring via `flex-basis: 0` + `aspect-ratio` (max `10rem`) and trims
  the legend to the rows the ring leaves (`DonutChart.svelte:95,169-177`).
  `KpiWidget` keeps the tiles and drops whole blocks — the mix bar first, then
  the token breakdown — based on measured natural heights
  (`KpiWidget.svelte:90-117,143-176`). `TimeSeriesChart` drops both axes below
  `COMPACT_HEIGHT = 120` and rebuilds the instance once at that boundary
  (`TimeSeriesChart.svelte:54,149,174-179`).

---

## 2. Color & tokens

- **Semantic tokens only.** Components use the semantic aliases in
  `src/app.css`; the raw palette scales (`--blue-dark-*`, `--amber-dark-*`,
  `--ember-dark-*`, `--mint-dark-*`, `--cobalt-dark-*`, `--solaris-dark-*`,
  `--lilac-dark-*`) are an implementation detail of `app.css` itself
  (`src/app.css:158-191`).
- **Core token groups:** backgrounds `src/app.css:65-69`; surfaces
  (`--surface-*`) `src/app.css:71-104`; text (`--text-*`) `src/app.css:106-117`;
  borders (`--border-*`) `src/app.css:119-134`; tree/overlay aliases
  (`--overlay-hover`, `--overlay-pressed`, `--border-muted`, `--text-faint`)
  `src/app.css:136-143`; icons `src/app.css:145-156`.
- **Chart palette.** `--chart-1 … --chart-7` alias the palette levels 9
  (`src/app.css:185-191`). Legend wording/chips consume the same status tokens
  as the chart.
- **Accepted dependency exception: `uplot`.** The one runtime dependency after
  `src/app.css` (`uplot@^1.6.32`, MIT, `package.json:25`), used **only** by the
  two dense time-series widgets (`sessions-per-day`, `cost-per-day`) through
  `TimeSeriesChart.svelte`. It is canvas-based and client-only: dynamically
  imported inside `onMount` (`TimeSeriesChart.svelte:159-160`), so it never
  enters the SSR graph or the initial bundle. Size (pinned `1.6.32` build):
  ≈50 KB minified / ≈22 KB gzip; the epic's ADR quotes ≈45 KB min / ≈15 KB gzip.
  **Every other widget stays hand-rolled inline SVG** over the `--chart-*`
  tokens (`BarChart`, `DonutChart`, the KPI mix bar) — no second chart library.
- **No hardcoded legacy hex.** No `.svelte` file may hardcode a hex from the
  pre-theme palette; the guard walks every `.svelte` under `src/` against
  `LEGACY_PALETTE` (`pages.suite.ts`: "no component keeps the legacy hardcoded
  hex palette (model palette excepted)").
- **Single accepted exception:** the data-layer `MODEL_PALETTE`
  (`src/lib/model/gantt.ts:15-26`), a pastel, blue/cyan-free model-color set.
  See [§4](#4-status-semantics).
- **Compat layer.** The bottom of `:root` maps pre-theme legacy names
  (`--bg`, `--surface`, `--border`, `--fg`, `--muted`, `--accent`) onto the
  theme tokens (`src/app.css:214-220`). New markup must not use these; treat
  them as migration shims only.

---

## 3. Typography

- Families: `--font-family-sans` and `--font-family-mono`
  (`src/app.css:15-20`). Body text is `--font-size-base` (14px) with
  `--line-height-large` (`src/app.css:235-241`).
- Sizes `--font-size-xs/sm/small/base/large/x-large`, weights
  `--font-weight-regular/medium`, line heights
  `--line-height-normal/large/x-large` (`src/app.css:21-31`).
- **Numbers use `font-variant-numeric: tabular-nums`** so token/cost/time
  columns stay aligned (e.g. `GanttHeader.svelte:99,116`,
  `NodeIdentity.svelte:74`, `StepRow.svelte:122,161`, `SubRow.svelte:194,233`,
  `NodeActionsTable.svelte:311,356`, `SessionSidebar.svelte:590`,
  `TaskDetailView.svelte:165`, `src/routes/sessions/[id]/+page.svelte:100,138,153`).
  Timestamps follow the same rule; their zone handling is [§11](#11-timestamp-rendering).
- **Identifiers and raw payloads use mono** (`var(--font-family-mono)`): session
  ids (`NodeIdentity.svelte:98`), raw JSON (`RawJsonBlock.svelte:58`), IO values
  (`IoBlock.svelte:100`), tool/action text (`ToolCallCard.svelte:194`,
  `ActionCard.svelte:98`, `StepRow.svelte:112`, `SubRow.svelte:184`),
  summary ids (`NodeSummaryStrip.svelte:213`).

---

## 4. Status semantics

The semantic status tokens are the only color source for
success/warning/danger/info/accent:

| Family | Tokens (`src/app.css`) |
|---|---|
| success | `--color-success-base/strong/surface` (`:197-199`) |
| warning | `--color-warning-base/strong/surface` (`:200-202`) |
| danger | `--color-danger-base/strong/surface`, `--color-danger-border` (`:203-206`) |
| info | `--color-info-base/strong/surface` (`:207-209`) |
| accent | `--color-accent-base/strong/surface` (`:210-212`) |

- Status tokens alias the palette levels 9/11 with a 22% `color-mix` surface
  (`src/app.css:197-212`); components never reference the raw palette.
- **Agent colors** map opencode frontmatter `color:` tokens to these tokens via
  `AGENT_COLOR_VARS` (`src/lib/model/agent.ts:16-24`); an unknown/absent token
  falls back to the neutral `--icon-base` (`AGENT_FALLBACK_COLOR`,
  `src/lib/model/agent.ts:31`). Agent swatches use `.ui-swatch` and set the
  background as data (e.g. `GanttLabelRow.svelte:79`, `SettingsModal.svelte:433`).
- **Chart / model colors:** `MODEL_PALETTE` is the sole accepted raw-color
  exception (see [§2](#2-color--tokens)); assigned first-seen order by
  `assignModelColors` (`src/lib/model/gantt.ts:52-61`).
- **Tool tones** are collapsed from the raw status string to
  `completed | error | running | other` by `toolTone`
  (`src/lib/model/gantt.ts:28-46`); the badge tone follows through dynamic
  composition (`ui-badge--${flagTone(key)}` → `warning|danger`,
  `src/app.css:354-356`).

---

## 5. Focus & accessibility

- **One global focus ring.** A single `:where(a, button, input, select, textarea,
  [tabindex]):focus-visible` rule draws the ring (`src/app.css:251-257`).
  Components must not redeclare it.
- **Inset variant:** `.ui-focus-inset` (`outline-offset: -2px`,
  `src/app.css:259-261`) is for rows that clip an outward outline (sidebar rows,
  `SessionSidebar.svelte:259,291,375,405`).
- **Screen-reader-only utility:** `.sr-only` (`src/app.css:263-274`) — used for
  the search label (`SessionSidebar.svelte:322`) and the copy status
  (`ToolCallCard.svelte:80`).
- **Keyboard conventions:**
  - Gantt node rows are focusable buttons (`role="button"`, `tabindex="0"`) and
    select on **Enter or Space**, with `preventDefault`
    (`Gantt.svelte:103-108`; row wiring `GanttNodeRow.svelte`).
  - Off-canvas sidebar focus management runs only on the narrow breakpoint:
    opening focuses the first focusable element, closing restores focus to the
    toggle (`+layout.svelte:39-53`). The closed panel is `visibility: hidden`, so
    it leaves the tab order.
- **Node-label cell click target.** Every pixel of a Gantt label cell selects
  the node: `.label-btn` spans the row and a full-bleed `.label-btn::after`
  (`position: absolute; inset: 0`) covers the pixels after the tracker strip,
  while the pinned `.node-refs` strip is `pointer-events: none` and re-enables
  events only on its own buttons — so the tracker controls stay interactive and
  never select the row (`GanttLabelRow.svelte:176-180,221-240`). The label cell
  itself does not clip (`overflow: visible`) so the refs dropdown can escape it
  (`GanttLabelRow.svelte:104-124`).
- **Reduced motion:** programmatic scrolls use `behavior: 'auto'` when
  `window.matchMedia('(prefers-reduced-motion: reduce)').matches`, otherwise
  `'smooth'` (`NodeDetailPanel.svelte:198`, `NodeActionsTable.svelte:95`).
- **ARIA:** selection is exposed with `aria-pressed={row.active}` and is
  **selection-only** — hover must never set it (`Gantt.svelte:98,103-108`;
  guarded by `pages.suite.ts`, "aria-pressed/selected derives from
  selectedNodeId only, never hover"). Dialogs are labelled; see
  [§9](#9-modal--dialog-contract).
- **No raw HTML injection.** No `.svelte` surface under `src/` may use
  `{@html}` or import a server-only module (`pages.suite.ts`: "no client
  `.svelte` surface uses {@html} or imports a server-only module"). Svelte's
  default escaping is the XSS boundary (`m3c-drilldown.suite.ts`, rendered
  escaping tests).

---

## 6. Shared primitives (`ui-*`)

### Class vs. component rule

An element stays a **plain `.ui-*` CSS class** in `src/app.css` **iff all** of:

1. it renders a **single DOM node** (no internal element tree);
2. its entire contract is **styling + built-in pseudo-state** (`:hover`,
   `:focus-visible`, `:active`, `:disabled`, `[data-*]`) with **no JS state,
   lifecycle, timer, observer or event wiring**;
3. it exposes **no typed API** beyond class composition (no variant/size/`name`
   prop, no bindable value).

It becomes a **Svelte component** as soon as **any** of:

1. it owns behaviour (`$state`, `$effect`, observers, timers, focus/keyboard
   logic, pointer handling);
2. it has a **multi-element internal structure** that must stay consistent, or
   must be composed with a snippet;
3. it needs a **typed parameter API** (`name` / `tone` / `size` unions) or
   bindable state;
4. it is a **repeated pattern with behaviour** whose duplication would drift
   across call sites.

Consequence: there are intentionally **no** `Badge` / `Chip` / `Button` wrapper
components — variants stay `class="ui-badge ui-badge--{tone}"` until a typed API
is actually needed. The rule is reproduced verbatim in the `src/app.css`
comment block (`src/app.css:280-303`).

### `.ui-*` catalog

Every `.ui-*` class defined in `src/app.css`, with purpose, modifiers and
states (`src/app.css:305-376`). `unused` marks a class defined here but
referenced by no current markup; it is kept deliberately for call sites to
adopt (do not delete).

**Focus**
- `.ui-focus-inset` — inset variant of the global focus ring (rows that clip an
  outward outline); defined above.

**Buttons**
- `.ui-btn` — default bordered action button; states `:hover`, `:active`,
  `:disabled`.
- `.ui-btn--primary` — raised emphasis (`--surface-raised-*` tokens).
- `.ui-btn--danger` — destructive tone (danger border/text, danger hover
  surface). **unused.**
- `.ui-btn--block` — full-width button.
- `.ui-icon-btn` — square, borderless icon-only control (gear, copy…); hover
  uses the neutral overlay.
- `.ui-link-btn` — borderless inline text action; `:hover` underlines and
  brightens to `--text-strong`.
- `.ui-swatch` — fixed 8px agent colour chip; geometry is standard, the
  background colour is data (agent frontmatter).

**Inputs**
- `.ui-input` — full-width text input; `::placeholder` uses `--text-weak`.

**Chips and badges** (pills; no wrapper components by the rule above)
- `.ui-chip` — pill container for tracker refs / filters; the inert ref text
  when no tracker base is configured.
- `.ui-chip--link` — clickable `#N` chip that opens the task modal.
- `.ui-chip--toggle` — pressable toggle/filter chip: the node-column `N tasks`
  disclosure trigger and the detail filter.
- `.ui-badge` — small status pill, neutral by default.
- `.ui-badge--success` — generic success tone. **unused.**
- `.ui-badge--warning` — generic warning tone (`flagTone`: running / `end=null` /
  openStep).
- `.ui-badge--danger` — generic danger tone (`flagTone` default).
- `.ui-badge--info` — generic info tone. **unused.**
- `.ui-badge--accent` — generic accent tone. **unused.**
- `.ui-badge--mcp` — MCP tool-call marker.
- `.ui-badge--text` — action kind "text".
- `.ui-badge--file` — action kind "file".
- `.ui-badge--deleg` — delegation tool-call marker.
- `.ui-badge--reasoning` — action kind "reasoning".
- `.ui-badge--agent` — action kind "agent".
- `.ui-badge--patch` — action kind "patch".
- `.ui-badge--perm` — permission-request tone.
- `.ui-badge--removed` — removed/rejected marker and rejected permission.
- `.ui-badge--compaction` — compaction marker / action kind.

**Tracker-ref display (L2 `TrackerChipList`).** Every surface that renders
inferred refs (the Gantt node column, the node summary strip) uses the one
`TrackerChipList` mechanism: 0 refs render nothing, 1 ref renders a single `#N`
`.ui-chip--link` button, and `>=2` refs collapse into an `N tasks`
`.ui-chip--toggle` whose disclosure list holds one `#N` button per ref
(`TrackerChipList.svelte:147-201`). The toggle exposes `aria-expanded` and
`data-refs-toggle` (`TrackerChipList.svelte:166-175`); the list closes on
Escape, an outside pointer press, choosing a ref, or the pointer leaving the
whole control, and flips up when the nearest clipping ancestor leaves no room
below. A `150ms` grace delay bridges the trigger→panel gap — the panel is
absolutely positioned one `--space-1` below the trigger, so leaving the trigger
alone must not close it before the pointer reaches the panel, and `mouseenter`
on the wrapper cancels the pending close
(`TrackerChipList.svelte:37-77,105-125,159-165`). With `onOpen` omitted (no
tracker base) the refs stay inert `.ui-chip` text
(`TrackerChipList.svelte:193-201`). This replaces the former `>=4` collapse /
`Show fewer` expander — there is no separate expand state or `Show fewer` label.

Some tones reach markup only through dynamic composition —
`ui-badge--${flagTone(key)}` → warning|danger,
`ui-badge--${marker.type}` → compaction|removed,
`ui-badge--${action.kind}` → text|reasoning|patch|file|agent|compaction — so a
literal-token grep reports them unused; they are live.

**Card**
- `.ui-card` — widget surface: column flow, `--space-4` padding,
  `--background-strong` background, `--border-weak-base` border,
  `--radius-lg`. It renders a single DOM node and carries styling only (no
  behaviour), so by the class-vs-component rule it stays a plain class; the
  dashboard's `WidgetCard` and `SkeletonWidget` consume it
  (`WidgetCard.svelte:40`, `SkeletonWidget.svelte:19`).

**Modal** (structure only; focus trap / Escape behaviour lives in the feature
components that own it — a `ModalShell` composite is deferred, see
[§9](#9-modal--dialog-contract))
- `.ui-modal` — fixed full-viewport centering wrapper.
- `.ui-modal__backdrop` — clickable dimming layer.
- `.ui-modal__dialog` — the dialog surface (border, radius, `shadow-lg`).
- `.ui-modal__head` — header row (title + close), bottom border.
- `.ui-modal__title` — dialog heading.
- `.ui-modal__body` — scrollable content region.
- `.ui-modal__content` — padded content inner block.
- `.ui-modal__foot` — footer action row, top border.

**Notice**
- `.ui-notice` — inline success notice text (`role=status` call sites;
  `SettingsModal.svelte:604`).

**Not `.ui-*`, but shared from this layer:** `.muted` (weak text) and `.sr-only`
(screen-reader-only) are defined above the primitives section
(`src/app.css:247-274`).

---

## 7. Icons

- **`Icon.svelte`** (L1 primitive) is the shared inline-SVG set. Its glyph union
  is `'gear' | 'menu' | 'close' | 'copy' | 'check' | 'expand' | 'collapse' |
  'arrow-up' | 'refresh'`, with an optional `size` (`default 16`)
  (  `src/lib/components/primitives/Icon.svelte:8-17`). Color inherits via
  `currentColor`; every glyph is `aria-hidden="true"` and `focusable="false"`.
  It states the no-emoji rule (`Icon.svelte:3`).
- **`TreeIcon.svelte`** is the tree-only chevron/folder provider:
  `'chevron' | 'folder'`, optional `expanded` (chevron points down when
  expanded, right when collapsed) and `size`, `currentColor`, `aria-hidden`
  (`src/lib/components/primitives/TreeIcon.svelte:7-15,17-50`).
- **No emoji glyphs anywhere in the UI**; use an `Icon`/`TreeIcon` name.
- Icons render `display: block; flex: none` (`Icon.svelte:143-147`,
  `TreeIcon.svelte:52-56`).

---

## 8. Scroll contract

- **Every scroll region is a `ScrollView`.** The primitive
  (`src/lib/components/primitives/ScrollView.svelte`) renders a flex wrapper
  with a scrollable viewport whose native bar is hidden
  (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`,
  `:281-305`) plus one absolutely-positioned overlay thumb per scrollable axis.
- **No native `overflow: auto/scroll` outside `ScrollView`.** The guard walks
  every `.svelte` under `src/` (skipping `ScrollView.svelte`) and fails on any
  `overflow(-x/-y): auto|scroll` (`scroll-view.suite.ts`, "no component keeps a
  native auto/scroll overflow outside ScrollView"). Non-`ScrollView` overflow
  is limited to `hidden`/`clip`.
- **Orientation:** `vertical` (default), `horizontal` or `both`; the viewport
  sets `overflow-y: auto`, `overflow-x: auto` or `overflow: auto` respectively
  (`ScrollView.svelte:289-301`). Sections that only clamp use
  `overflow: hidden` (e.g. Gantt `.scroll`, `+layout.svelte .content`).
- **Neutral thumbs only.** Thumb color is `--border-weak-base` (base) /
  `--border-strong-base` (hover/drag) — never a blue/cyan value
  (`ScrollView.svelte:333-362`; guarded by `scroll-view.suite.ts` and
  `pages.suite.ts`). Thumb visibility is `hover` (default), `scroll` or
  `always`; it auto-hides `800ms` after the last scroll
  (`ScrollView.svelte:47,67-72,122-128`).
- **Adoption:** the content column is the single vertical scroll region
  (`+layout.svelte:67`); the sidebar header is outside its inner `ScrollView`
  (`SessionSidebar.svelte`); the Gantt chart is wrapped in a horizontal
  `ScrollView` (`Gantt.svelte`); `NodeActionsTable`, `IoBlock` and
  `RawJsonBlock` wrap their values. Verification names each site
  (`scroll-view.suite.ts`, "ScrollView adoption — every native scroll region is
  wrapped").
- **Thumbs are client-only:** SSR renders wrapper + viewport + children with no
  thumb (`scroll-view.suite.ts`, "no thumb renders before the client measures").

---

## 9. Modal / dialog contract

- **Structure is the `.ui-modal*` classes** in `src/app.css` (see
  [§6](#6-shared-primitives-ui-)); a component adds sizing only
  (`TaskModal.svelte:143-149`, `SettingsModal.svelte:623`).
- **Dialog semantics:** `role="dialog"`, `aria-modal="true"`, `tabindex="-1"`,
  and a label (`aria-label` or `aria-labelledby`), on the
  `.ui-modal__dialog` element (`TaskModal.svelte:110-118`;
  `SettingsModal.svelte:467-475`). The backdrop is a button with a close
  `aria-label` (`TaskModal.svelte:104-109`, `SettingsModal.svelte:460-465`).
- **Behaviour owned by the component** (a `ModalShell` composite is **not**
  landed):
  - **Escape** closes (`TaskModal.svelte:77-82`;
    `SettingsModal.svelte:205`).
  - **Focus trap:** Tab/Shift+Tab cycle within the dialog
    (`TaskModal.svelte:83-100`; `SettingsModal.svelte:211-225`).
  - **Initial focus and focus return:** the dialog is focused on mount and the
    previously focused element is restored on unmount
    (`TaskModal.svelte:72-75`; `SettingsModal.svelte:163-176`).
- The panel body hosts a `ScrollView` (`.ui-modal__body` + `.ui-modal__content`,
  e.g. `TaskModal.svelte:125-137`).
- **Detail payload is validated, not re-normalised.** The modal fetches
  subagentix's own `/api/tracker/task/:id` proxy, whose server layer already
  mapped ziptask's snake_case fields to the camelCase `TrackerTaskDetail`; the
  client therefore validates that contract with `isTaskDetail` instead of
  re-running `normaliseTaskDetail`, so real `createdAt`/`updatedAt`
  (Created/Updated) render instead of the normaliser's empty-string defaults
  (`TaskModal.svelte:49-55`; `src/routes/api/tracker/task/[id]/+server.ts:53`;
  `src/lib/model/tracker.ts:116-149,151-176`).
- **SSR:** a closed modal renders no dialog markup (guarded by `pages.suite.ts`,
  "SSR closed-modal: settings button present, no dialog markup"); an open
  `TaskModal` renders the accessible loading dialog
  (`m3c-drilldown.suite.ts`, "TaskModal SSR — dialog shell and loading state").

---

## 10. Layer & component conventions

### Layer model

Dependency direction is strictly downward; a component at layer *n* may import
layers `1..n`, never an upper layer.

| Layer | What | Examples |
|---|---|---|
| L0 tokens | `src/app.css` custom properties + element/base styles + `.ui-*` classes | design tokens |
| L1 primitives | single-purpose, context-free | `Icon`, `TreeIcon`, `ScrollView` |
| L2 composites | assemble primitives, still context-free | `TrackerChipList`, `SummaryLine`, `IoBlock`, `BackToTableButton`, `WidgetCard`, `SkeletonWidget` |
| L3 feature | domain-aware roots + their presentation children | `Gantt`, `NodeDetailPanel`, `SessionSidebar`, `SettingsModal`, `TaskModal`, `Dashboard`, `WidgetHost` |
| L4 page | routes | `+layout.svelte`, `+page.svelte`, `sessions/[id]/+page.svelte` |

### Landed directory layout

Feature folders:
`src/lib/components/features/{dashboard,gantt,node-detail,sidebar,settings,tracker}`.

```
src/
  app.css                                       # L0: tokens + .ui-* + base styles
  lib/
    model/                                      # pure domain math + formatters (SSR-safe)
      chart.ts                                  # scale/tick/bucket/arc math for the charts
      dashboard.ts                              # dashboard DTOs, period + window rules
      agent.ts  format.ts  gantt.ts  node.ts  paging.ts  token.ts  tracker.ts
      types.ts  clock.svelte.ts
    widgets/
      registry.ts                               # WidgetId/WidgetDef/WidgetPlacement/WIDGET_DEFS (client-safe)
      registry.test.ts                          # registry + resolvePlacements/clamp units
    components/
      primitives/                               # L1
        Icon.svelte  TreeIcon.svelte  ScrollView.svelte
      composites/                               # L2
        TrackerChipList.svelte  SummaryLine.svelte
        IoBlock.svelte  BackToTableButton.svelte
      features/
        dashboard/                              # L3 shell + its L2 card pieces
          Dashboard.svelte                      # shell root (owns selection)
          DashboardHeader.svelte  WidgetGrid.svelte  FilterSelector.svelte
          WidgetHost.svelte                     # lazy mount boundary (#409)
          WidgetCard.svelte  SkeletonWidget.svelte  WidgetsModal.svelte
          widget.ts                             # loader/status contract (#409)
          data.svelte.ts                        # useWidgetData rune hook (#410)
          loaders.ts                            # per-widget code-split loaders
          filter.ts  picker.ts  top-tools.ts  fit.ts  # pure helpers (unit-tested)
          fit.svelte.ts                         # useRowFit measurement rune (#444)
          TimeSeriesChart.svelte                # uPlot time series (§2)
          BarChart.svelte  DonutChart.svelte    # hand-rolled inline SVG (§2)
          KpiWidget.svelte  TopToolsWidget.svelte
          SessionsPerDayWidget.svelte  CostPerDayWidget.svelte
          TopProjectsWidget.svelte  AgentDistributionWidget.svelte
          # tests (co-located): dashboard-widgets.suite.ts + .test.ts wrapper,
          # data/filter/picker/top-tools/fit.test.ts, source-guards.test.ts
        gantt/                                  # L3
          Gantt.svelte                          # feature root (orchestrator)
          GanttHeader.svelte  GanttLabels.svelte  GanttLabelRow.svelte
          GanttChart.svelte  GanttNodeRow.svelte  GanttEdges.svelte
          GanttCursor.svelte  GanttLegend.svelte
        node-detail/
          NodeDetailPanel.svelte                # feature root (orchestrator)
          NodeSummaryStrip.svelte  NodeIdentity.svelte
          NodeActionsTable.svelte  StepRow.svelte  SubRow.svelte
          NodeDetailsList.svelte  ToolCallCard.svelte  ActionCard.svelte
          RawJsonBlock.svelte
        sidebar/SessionSidebar.svelte
        settings/SettingsModal.svelte
        tracker/TaskModal.svelte  TaskDetailView.svelte
  routes/                                       # L4 pages + route-level *.suite.ts / *.test.ts
```

- Tests are co-located with what they guard: route-level suites under
  `src/routes/**` and feature/unit suites beside their modules
  (`features/dashboard/*.suite.ts`, `model/*.test.ts`).
- Not landed (deferred by the ADR): `composites/ModalShell.svelte` and
  `features/gantt/view.ts`.
- **State ownership:** feature roots keep interactive state and cross-block
  behaviour; extracted children are presentation-only and receive precomputed
  props + callbacks (e.g. `Gantt.svelte` keeps selection/hover/cursor/scroll,
  `NodeDetailPanel.svelte` keeps filters/expanded/copy/scroll).

### Dashboard widget persistence

The dashboard selection and per-widget sizes persist in `settings.json` under
`dashboardWidgets`, written by the settings store (`src/lib/server/settings.ts`)
and read back through `resolveDashboardWidgets` (`settings.ts:347-349`).

- **Current shape:** `dashboardWidgets` is a `{ id, width, height }[]` — one
  `WidgetPlacement` per selected widget (`settings.ts:36`, `registry.ts:46-52`).
  The file payload carries `version: 2` on every write (`settings.ts:267`).
- **Legacy `string[]` still loads.** A v1 file whose `dashboardWidgets` is a
  bare id list (`["kpi","top-tools"]`) is accepted and resolved to placements
  with the registry-default sizes; unknown ids are dropped, duplicates collapse
  first-wins and the result is returned in registry order
  (`normaliseDashboardWidgets`, `settings.ts:142-179`; `resolvePlacements`,
  `registry.ts:189-206`). The same acceptance applies to a legacy `string[]`
  `PUT /api/settings` payload (`src/routes/api/settings/+server.ts:113-116`).
- **Validation.** A non-array, a non-string/non-object entry, a non-finite
  `width`/`height` or an oversized list (>24 entries) is rejected with
  `SettingsValidationError('dashboardWidgets')`; a hand-edited invalid list on
  disk degrades to the registry defaults rather than failing the read
  (`settings.ts:142-179,208-214`).
- **First visit.** With no stored override, `resolveDashboardWidgets` falls
  back to `DEFAULT_WIDGETS` (the `defaultOn` registry entries with their default
  sizes, `registry.ts:151-153`).

### Naming & import rules

- Components: `PascalCase.svelte`; one component per file; the file name equals
  the exported component.
- Directories: `kebab-case` (`node-detail/`, not `NodeDetail/`).
- Pure modules: co-located `camelCase.ts`; use `.svelte.ts` only if they use
  runes.
- Imports: `$lib/components/<layer>/<Name>.svelte` across layers; relative
  `./Sibling.svelte` inside one feature folder. Never deep-relative across
  features (`../../gantt/...`).
- Layout constants shared across a feature live in one co-located module once a
  second component needs them; until then they stay in the root.

### Svelte 5 idioms (mandatory for new / extracted components)

- Props via `let { … }: Props = $props();` with a local `interface Props` — no
  `export let`. (Example: `Gantt.svelte:39-54`, `ScrollView.svelte:22-42`.)
- Children and named slots → **snippets**: `children: Snippet`, rendered with
  `{@render children()}`. (Examples: `ScrollView.svelte:16,23,232`;
  `IoBlock.svelte:33`; `SummaryLine.svelte:30`; optional child
  `GanttChart.svelte:64`.)
- Events → **callback props** (`onSelect?: (id: string) => void`), never
  `createEventDispatcher`. (Examples: `NodeDetailPanel.svelte:45`;
  `Gantt.svelte:545-547`.)
- Two-way values → `$bindable()`. (Examples: `ScrollView.svelte:40-41`;
  `GanttLabels.svelte:34`.)
- State: `$state` / `$derived` / `$derived.by` / `$effect` (with a cleanup
  return). `$derived.by` is used for row/view-model derivations
  (`Gantt.svelte:334,469`; `NodeDetailPanel.svelte:142`;
  `SessionSidebar.svelte:94`).
- `$state.raw` is the prescribed idiom for large immutable view-model arrays
  (`RowView[]`, `NodeRow[]`) to avoid deep-proxy cost. **Not yet used in the
  landed tree** (no `$state.raw` under `src/`); adopt it in new extractions
  where the whole array is replaced, not mutated.
- `$effect` is client-only, so SSR renders the same static markup — this is what
  keeps the SSR suites green and makes the timestamp zone swap
  ([§11](#11-timestamp-rendering)) hydration-safe.
- No `{@html}` anywhere, and no `$lib/server` / `bun:sqlite` import in any
  client component (guarded globally; see [§12](#12-verification-map)).

---

## 11. Timestamp rendering

Timestamps are formatted for the visitor, but server-rendered as UTC so the
hydrated DOM matches the server markup (task #371).

- **Formatted for the visitor's zone.** Timestamps render in the browser's IANA
  zone as `YYYY-MM-DD HH:MM:SS`; the Gantt axis/cursor use `HH:MM:SS`
  (`formatClock`) and dates use `Mon D, YYYY` (`formatDate`). A non-finite value
  renders `—`.
- **SSR renders UTC; the client swaps after hydration.** The server and the
  first client render both use the `'UTC'` default, so there is no hydration
  mismatch. The swap happens once after mount and is tracked by Svelte, so every
  timestamp call site re-renders.
- **Reactive source:** `src/lib/model/clock.svelte.ts` — `clock` is
  `$state({ tz: 'UTC' })` (`clock.svelte.ts:12`); `initBrowserTimeZone()`
  resolves `Intl.DateTimeFormat().resolvedOptions().timeZone` into `clock.tz`
  (`clock.svelte.ts:19-26`) and never throws — an unsupported/empty zone leaves
  UTC in place.
- **Initialisation:** `+layout.svelte:16` imports it and `+layout.svelte:25`
  calls it from `onMount`, so the swap is client-only.
- **The formatters stay pure and take the zone as data.** `format.ts` is
  runes-free and every helper takes an explicit IANA `timeZone` defaulting to
  `'UTC'`: `formatDateTime` (`format.ts:84`), `formatIsoDateTime`
  (`format.ts:91`), `formatClock` (`format.ts:98`), `formatDate`
  (`format.ts:120`). `Intl.DateTimeFormat` is memoised per zone
  (`format.ts:18`), and an unknown zone falls back to UTC instead of throwing
  (`format.ts:31-44`).
- **Call sites pass `clock.tz`.** Components read it at every format call (e.g.
  `GanttHeader.svelte:51`, `SubRow.svelte:97,162`,
  `TaskDetailView.svelte:23-25,67`); `formatToolCallText(call, tz = 'UTC')`
  (`node.ts:334`) forwards the zone to `formatDateTime`
  (`node.ts:341-342`). A source guard fails the suite when a `.svelte` call
  site omits `clock.tz` (`format.test.ts:140-176`).

---

## 12. Verification map

The contract is executable: each rule is guarded by a suite. Source-text
assertions are **move-targeted, not deletable** — when markup moves, re-home the
assertion to the file that now owns the string.

| Suite | Guards |
|---|---|
| `src/routes/pages.suite.ts` | built `adapter-node` shell: full-width layout / no centered max-width, built dark tokens, legacy-hex ban, shell client hygiene, SSR closed-modal, scroll ownership in built CSS, inspector below chart + first-node auto-open, closed-sidebar focus safety, Gantt selection vs hover, dark running hatch |
| `src/routes/m3c-drilldown.suite.ts` | SSR `NodeDetailPanel` drill-down (steps numbered by list position, truncation/Expand, Details, raw JSON, escaping), `TaskModal` dialog shell, `TaskDetailView` camelCase-payload regression (real Created/Updated/completedAt, `maxAttempts`, epic id), Gantt focusable rows / no panel before selection, source wiring (keyboard, jump ids, reduced-motion scroll) |
| `src/lib/components/scroll-view.suite.ts` | `ScrollView` wrapper / viewport / thumb CSS, client behaviour (visibility, auto-hide, drag), adoption (every scroll region wrapped), no native overflow outside `ScrollView`, sidebar/gantt layout contracts |
| `src/routes/m4a-tracker.suite.ts` | Gantt inferred-task refs: open the modal, feature toggle, the unified `>=2` collapse into an `N tasks` toggle + disclosure list, no-link/unconfigured bases, escaping / raw-HTML hygiene, the node-column contract (full-bleed label selection, tracker controls excepted), and the `TrackerChipList` pointer-leave close wiring (`scheduleLeave`/`cancelLeave`, `150ms` grace timer, client-only dropdown) |
| `src/lib/components/characterization.suite.ts` | render-level SSR structure fingerprint of `Gantt` and `NodeDetailPanel` |
| `src/lib/components/features/dashboard/dashboard-widgets.suite.ts` | SSR structure of the widget primitives (`WidgetCard` status branches, `SkeletonWidget`, `BarChart`, `DonutChart`, `TimeSeriesChart` sr-only table + visible fallback), `WidgetGrid` `data-w`/`data-h` per placement + the 4-col/`row dense`/6rem grid rules and both clamp breakpoints, and `loaders.ts` id→body routing |
| `src/lib/components/features/dashboard/source-guards.test.ts` | uPlot reached only via dynamic `import('uplot')` inside `onMount` (no static/type import), cleanup destroys the instance, `WidgetHost` `IntersectionObserver` guard, `WidgetGrid` grid/clamp source rules, `WidgetCard` refresh-spin + reduced-motion guard, `BarChart` row cap is fit-driven (no hardcoded default), pure modules stay DOM/`$lib/server`-free |
| `src/lib/widgets/registry.test.ts` | `WIDGET_DEFS` catalog/order + default sizes + per-widget `minHeight`, `isWidgetId`, `clampWidth`/`clampHeight`/`clampWidgetHeight`, `resolvePlacements` (legacy `string[]`, `{id,width,height}` objects, mixed, dedupe first-wins, clamp, registry order, non-array), registry source stays server/DOM-free |
| `src/lib/components/features/dashboard/picker.test.ts` | `toggleWidgetSelection` (registry-default size on add), `samePlacements` (size-only change is dirty), `updatePlacement`, picker source stays DOM/`$lib/server`-free |
| `src/lib/components/features/dashboard/fit.test.ts` | `rowsThatFit` whole-row budget: floor/ceiling clamps, `total` cap, non-finite/zero box → floor (never `NaN`/`Infinity`/fractional) |

Additional guards: `src/routes/api/settings/settings.suite.ts` (settings modal
source/paths), `src/routes/api/settings/settings-dashboard.suite.ts` (the
`dashboardWidgets` PUT/GET contract: object payloads, `version: 2` on disk, the
legacy `string[]` echo), `src/lib/server/settings.test.ts` (store round-trip,
legacy `string[]` read fallback, `version: 2` write, per-widget `minHeight`
clamp on read),
`src/lib/components/scroll-view.test.ts`, `src/routes/pages.test.ts`,
`src/routes/m3c-drilldown.test.ts`, `src/routes/m4a-tracker.test.ts`
(isolated-child-process runners), the dashboard helper units
`features/dashboard/{data,filter,top-tools}.test.ts`, and the unit tests under
`src/lib/model/*.test.ts`: `format.test.ts` pins the tz-aware formatter cases
(Asia/Kolkata, America/New_York, invalid-zone UTC fallback) and guards that every
`.svelte` format call passes `clock.tz`; `node.test.ts` pins
`formatToolCallText`'s tz shift; `gantt.test.ts` pins the exact `MODEL_PALETTE`
colors.

**Characterization convention.** `characterization.suite.ts` freezes the SSR
structure of the two feature roots so every behaviour-preserving extraction is
mechanically verifiable:

1. Render via `vite.ssrLoadModule(<component>)` → `svelte/server render()`.
2. Normalize: strip Svelte scoped-class hashes (`svelte-*`), trim class
   attribute values, collapse whitespace, then compare.
3. Assert an ordered class-token list + key element counts + pinned attribute
   values for each root.
4. Include a **negative case**: feed deliberately corrupted HTML and assert the
   fingerprint helper throws, so the guard is not vacuous
   (`characterization.suite.ts`, "a removed class token breaks the
   fingerprint").

Any new extraction must keep the fingerprint unchanged; if behaviour genuinely
changes, update the fingerprint deliberately and say so in the task.
