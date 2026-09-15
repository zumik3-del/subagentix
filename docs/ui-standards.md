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
  suite ([§11](#11-verification-map)) win.
- No Tailwind, no UI library, no new runtime dependency. Plain CSS custom
  properties only.

---

## 1. Layout & spacing

- **4px spacing scale.** Spacing tokens `--space-1 … --space-12` are a 4px
  scale (`0.25rem … 3rem`), declared in `src/app.css:33-42`. Use the tokens, not
  raw `px`/`rem` values.
- **Full-viewport shell.** The app shell is a two-column grid
  (`grid-template-columns: var(--sidebar-width) minmax(0, 1fr)`) with
  `height`/`min-height: 100dvh`; the sidebar column is `position: sticky`
  (`src/routes/+layout.svelte:89-105`). `--sidebar-width` is `20rem`
  (`src/app.css:51`).
- **No centered max-width container.** List and session pages must not wrap
  content in a `max-width: 64rem` container or center it with `margin: auto`
  (guarded by `pages.suite.ts`, tests "list + session pages are not centered in
  a max-width container" and "layout source renders the full-viewport sidebar
  grid + narrow toggle").
- **Narrow viewport.** Below `--breakpoint-lg` (`64rem`, `src/app.css:52`) the
  shell collapses to one column (`@media (max-width: 63.99rem)`,
  `src/routes/+layout.svelte:130`) and the sidebar becomes an off-canvas overlay
  (`fixed`, `translateX(-100%)`, `visibility: hidden`) re-enabled by
  `.shell.sidebar-open` (`src/routes/+layout.svelte:135-154`).
- Radii (`--radius-xs … --radius-full`), shadows (`--shadow-xs/md/lg`) and
  `--sidebar-width` are declared in `src/app.css:44-63`.

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
  columns stay aligned (e.g. `GanttHeader.svelte:98,115`,
  `NodeIdentity.svelte:73`, `StepRow.svelte:121,160`, `SubRow.svelte:193,232`,
  `NodeActionsTable.svelte:311,356`, `SessionSidebar.svelte:589`,
  `TaskDetailView.svelte:164`, `src/routes/sessions/[id]/+page.svelte:99,137,152`).
- **Identifiers and raw payloads use mono** (`var(--font-family-mono)`): session
  ids (`NodeIdentity.svelte:97`), raw JSON (`RawJsonBlock.svelte:58`), IO values
  (`IoBlock.svelte:100`), tool/action text (`ToolCallCard.svelte:194`,
  `ActionCard.svelte:97`, `StepRow.svelte:111`, `SubRow.svelte:183`),
  summary ids (`NodeSummaryStrip.svelte:212`).

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
  `SessionSidebar.svelte:258,290,374,404`).
- **Screen-reader-only utility:** `.sr-only` (`src/app.css:263-274`) — used for
  the search label (`SessionSidebar.svelte:321`) and the copy status
  (`ToolCallCard.svelte:80`).
- **Keyboard conventions:**
  - Gantt node rows are focusable buttons (`role="button"`, `tabindex="0"`) and
    select on **Enter or Space**, with `preventDefault`
    (`Gantt.svelte:102-107`; row wiring `GanttNodeRow.svelte`).
  - Off-canvas sidebar focus management runs only on the narrow breakpoint:
    opening focuses the first focusable element, closing restores focus to the
    toggle (`+layout.svelte:33-47`). The closed panel is `visibility: hidden`, so
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
  `'smooth'` (`NodeDetailPanel.svelte:197`, `NodeActionsTable.svelte:95`).
- **ARIA:** selection is exposed with `aria-pressed={row.active}` and is
  **selection-only** — hover must never set it (`Gantt.svelte:97,102-107`;
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
  'arrow-up'`, with an optional `size` (`default 16`)
  (`src/lib/components/primitives/Icon.svelte:8-12`). Color inherits via
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
  (`+layout.svelte:61`); the sidebar header is outside its inner `ScrollView`
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
| L2 composites | assemble primitives, still context-free | `TrackerChipList`, `SummaryLine`, `IoBlock`, `BackToTableButton` |
| L3 feature | domain-aware roots + their presentation children | `Gantt`, `NodeDetailPanel`, `SessionSidebar`, `SettingsModal`, `TaskModal` |
| L4 page | routes | `+layout.svelte`, `+page.svelte`, `sessions/[id]/+page.svelte` |

### Landed directory layout

Feature folders: `src/lib/components/features/{gantt,node-detail,sidebar,settings,tracker}`.

```
src/
  app.css                                       # L0: tokens + .ui-* + base styles
  lib/
    model/                                      # pure domain math + formatters
    components/
      primitives/                               # L1
        Icon.svelte  TreeIcon.svelte  ScrollView.svelte
      composites/                               # L2
        TrackerChipList.svelte  SummaryLine.svelte
        IoBlock.svelte  BackToTableButton.svelte
      features/
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
  routes/                                       # L4 pages + *.suite.ts / *.test.ts
```

- Not landed (deferred by the ADR): `composites/ModalShell.svelte` and
  `features/gantt/view.ts`.
- **State ownership:** feature roots keep interactive state and cross-block
  behaviour; extracted children are presentation-only and receive precomputed
  props + callbacks (e.g. `Gantt.svelte` keeps selection/hover/cursor/scroll,
  `NodeDetailPanel.svelte` keeps filters/expanded/copy/scroll).

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
  `export let`. (Example: `Gantt.svelte:38-53`, `ScrollView.svelte:22-42`.)
- Children and named slots → **snippets**: `children: Snippet`, rendered with
  `{@render children()}`. (Examples: `ScrollView.svelte:16,23,232`;
  `IoBlock.svelte:33`; `SummaryLine.svelte:30`; optional child
  `GanttChart.svelte:64`.)
- Events → **callback props** (`onSelect?: (id: string) => void`), never
  `createEventDispatcher`. (Examples: `NodeDetailPanel.svelte:44`;
  `Gantt.svelte:544-546`.)
- Two-way values → `$bindable()`. (Examples: `ScrollView.svelte:40-41`;
  `GanttLabels.svelte:34`.)
- State: `$state` / `$derived` / `$derived.by` / `$effect` (with a cleanup
  return). `$derived.by` is used for row/view-model derivations
  (`Gantt.svelte:333,468`; `NodeDetailPanel.svelte:141`;
  `SessionSidebar.svelte:93`).
- `$state.raw` is the prescribed idiom for large immutable view-model arrays
  (`RowView[]`, `NodeRow[]`) to avoid deep-proxy cost. **Not yet used in the
  landed tree** (no `$state.raw` under `src/`); adopt it in new extractions
  where the whole array is replaced, not mutated.
- `$effect` is client-only, so SSR renders the same static markup — this is what
  keeps the SSR suites green.
- No `{@html}` anywhere, and no `$lib/server` / `bun:sqlite` import in any
  client component (guarded globally; see [§11](#11-verification-map)).

---

## 11. Verification map

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

Additional guards: `src/routes/api/settings/settings.suite.ts` (settings modal
source/paths), `src/lib/components/scroll-view.test.ts`,
`src/routes/pages.test.ts`, `src/routes/m3c-drilldown.test.ts`,
`src/routes/m4a-tracker.test.ts` (isolated-child-process runners), and the unit
tests under `src/lib/model/*.test.ts` (e.g. `gantt.test.ts` pins the exact
`MODEL_PALETTE` colors).

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
