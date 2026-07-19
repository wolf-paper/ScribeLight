# Lightscribe UI Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Lightscribe's basic stacked form with the approved 1280px timeline/list/inspector workspace, project-label settings, acoustic-tag dropdown, fixed intelligibility vocabulary, and four persistent palettes.

**Architecture:** Keep `App.svelte` as the native-operation coordinator while moving appearance preferences into a small browser-only theme module and moving UI concerns into focused Svelte components. Preserve the existing `ProjectStore`, timeline, WaveSurfer adapter, and Rust playback boundaries; only the intelligibility wire token crosses the TypeScript/Rust boundary. Theme colors flow through semantic CSS custom properties applied with `data-palette` on the document root.

**Tech Stack:** Svelte 5, TypeScript 5.6, Vitest and Testing Library, Playwright, Tauri 2, Rust/Serde, Bun.

## Global Constraints

- Work only on `feature/ui-rework` in `C:\Users\squnk\source\repos\wolf-paper\lightscribe\.worktrees\ui-rework`; never implement directly on `master`.
- Optimize for a 1280x800 desktop window with a 1280px minimum width; use relative grid sizing above the minimum and introduce no horizontal overflow at 1280px.
- Preserve native playback, waveform analysis, exact integer-millisecond loop boundaries, Ctrl+wheel pointer-centered zoom, project recovery, TSV overwrite protection, and source-audio immutability.
- Keep plain Enter as annotation Add/Update, Shift+Enter as a line break, and IME composition Enter as a no-op.
- The saved-annotation region is continuously scrollable with a sticky header and no pagination.
- Speakers and acoustic tags remain addable, removable, and renameable from Settings, retaining the existing speaker-reassignment and referenced-tag confirmation rules.
- Intelligibility is fixed to `unintelligible`, `partially_intelligible`, `highly_intelligible`, and `not_applicable`; accept legacy `intelligible`, then normalize saves and exports to `highly_intelligible` without changing schema version 1.
- Palettes are exactly Ion Magenta, Arctic Steel, Ultraviolet Grid, and Crimson Scope. Ion Magenta is the default and uses solid accent `#EF5BAD`, not the later muted-button experiment.
- Palette choice is application-global, stored under `lightscribe.palette`, absent from project JSON and TSV, and safely falls back to Ion Magenta when storage is missing, invalid, or unavailable.
- Follow test-first design. To honor the user's run-frequency constraint, write each task's tests first, then enter one uninterrupted pre-commit gate: run RED, implement, run GREEN plus adjacent regression checks, and commit immediately. Do not run tests outside those pre-commit gates.
- Every color-only distinction must also have text, an icon/shape, a border, or position cue; all icon-only buttons require accessible names.

---

### Task 1: Palette Domain and Preference Persistence

**Files:**
- Create: `src/lib/theme/palette.ts`
- Create: `src/lib/theme/palette.test.ts`
- Create: `src/lib/components/PaletteSelector.svelte`
- Create: `src/lib/components/PaletteSelector.test.ts`
- Modify: `src/main.ts`
- Modify: `src/main.test.ts`
- Modify: `src/app.css`

**Interfaces:**
- Produces `PaletteId`, `PALETTE_IDS`, `DEFAULT_PALETTE`, `normalizePalette`, `loadPalette`, `applyPalette`, `persistPalette`, and `stableColorSlot` from `src/lib/theme/palette.ts`.
- Produces `PaletteSelector` with props `{ value: PaletteId; disabled?: boolean; onchange(value: PaletteId): void }`.
- Later tasks consume `PaletteId`, `PaletteSelector`, `stableColorSlot`, and the semantic CSS variables.

- [ ] **Step 1: Write palette and selector tests before production code**

Create tests that specify the public API and visible palette choices:

```ts
expect(PALETTE_IDS).toEqual([
  'ion-magenta', 'arctic-steel', 'ultraviolet-grid', 'crimson-scope'
]);
expect(normalizePalette('unknown')).toBe('ion-magenta');
expect(loadPalette({ getItem: () => { throw new Error('denied'); } })).toBe('ion-magenta');
persistPalette('crimson-scope', storage, document.documentElement);
expect(document.documentElement.dataset.palette).toBe('crimson-scope');
expect(storage.setItem).toHaveBeenCalledWith('lightscribe.palette', 'crimson-scope');
expect(stableColorSlot('stable-id', 5)).toBe(stableColorSlot('stable-id', 5));
```

`PaletteSelector.test.ts` renders four radios, checks Ion Magenta initially, clicks Arctic Steel, and expects `onchange('arctic-steel')`. `main.test.ts` stores `ultraviolet-grid` before importing `main.ts` and asserts the root dataset is applied before the app is mounted.

- [ ] **Step 2: Enter the pre-commit gate and verify RED**

Run:

```powershell
bun x vitest run src/lib/theme/palette.test.ts src/lib/components/PaletteSelector.test.ts src/main.test.ts
```

Expected: FAIL because `src/lib/theme/palette.ts` and `PaletteSelector.svelte` do not exist and `main.ts` does not apply a palette.

- [ ] **Step 3: Implement the palette API and selector**

Implement this exact public surface, using `try/catch` around both storage operations:

```ts
export const PALETTE_IDS = [
  'ion-magenta', 'arctic-steel', 'ultraviolet-grid', 'crimson-scope'
] as const;
export type PaletteId = typeof PALETTE_IDS[number];
export const DEFAULT_PALETTE: PaletteId = 'ion-magenta';
export const PALETTE_STORAGE_KEY = 'lightscribe.palette';

export function normalizePalette(value: string | null): PaletteId {
  return PALETTE_IDS.includes(value as PaletteId) ? value as PaletteId : DEFAULT_PALETTE;
}

export function loadPalette(storage: Pick<Storage, 'getItem'>): PaletteId {
  try { return normalizePalette(storage.getItem(PALETTE_STORAGE_KEY)); }
  catch { return DEFAULT_PALETTE; }
}

export function applyPalette(value: PaletteId, root: HTMLElement = document.documentElement): void {
  root.dataset.palette = value;
}

export function persistPalette(
  value: PaletteId,
  storage: Pick<Storage, 'setItem'> = localStorage,
  root: HTMLElement = document.documentElement
): void {
  applyPalette(value, root);
  try { storage.setItem(PALETTE_STORAGE_KEY, value); } catch { /* Appearance remains usable. */ }
}

export function stableColorSlot(id: string, count: number): number {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) % count;
}
```

Call `applyPalette(loadPalette(localStorage))` in `main.ts` before `mountApp`. Build `PaletteSelector.svelte` as a labeled four-radio group whose cards contain five semantic swatches. Add the four exact variable sets from the design specification to `app.css`; include `color-scheme: dark` and shared speaker/status/tag tokens without restyling the full application yet.

- [ ] **Step 4: Verify GREEN and commit immediately**

Run:

```powershell
bun x vitest run src/lib/theme/palette.test.ts src/lib/components/PaletteSelector.test.ts src/main.test.ts
bun run check
```

Expected: all selected tests pass and Svelte reports 0 errors and 0 warnings.

Commit:

```powershell
git add src/lib/theme src/lib/components/PaletteSelector.svelte src/lib/components/PaletteSelector.test.ts src/main.ts src/main.test.ts src/app.css
git commit -m "feat: add persistent Lightscribe palettes"
```

### Task 2: Canonical Intelligibility Vocabulary and Legacy Migration

**Files:**
- Modify: `src/lib/domain/types.ts`
- Modify: `src/lib/domain/project.ts`
- Modify: `src/lib/domain/validation.ts`
- Modify: `src/lib/domain/importTsv.ts`
- Modify: `src/lib/bridge/native.ts`
- Modify: `src/App.svelte`
- Modify: `src/lib/domain/project.test.ts`
- Modify: `src/lib/domain/validation.test.ts`
- Modify: `src/lib/domain/importTsv.test.ts`
- Modify: `src/App.test.ts`
- Modify: `src/test/browserFakeBridge.ts`
- Modify: `src-tauri/src/model.rs`
- Modify: `src-tauri/src/persistence.rs`
- Modify: `src-tauri/src/tsv.rs`
- Modify: `src-tauri/tests/native_integration.rs`
- Modify: `tests/fixtures/pass-a.annotation.private.tsv`

**Interfaces:**
- Changes `Intelligibility` to `'highly_intelligible' | 'partially_intelligible' | 'unintelligible' | 'not_applicable'`.
- Produces `normalizeIntelligibility(value)` in `src/lib/domain/validation.ts` for legacy frontend/import data.
- Rust `Intelligibility::HighlyIntelligible` serializes as `highly_intelligible` and accepts `intelligible` as a deserialize alias.

- [ ] **Step 1: Write migration tests before changing production types**

Add frontend assertions that legacy imported `intelligible` becomes `highly_intelligible`, new projects default to `highly_intelligible`, and validation still requires text for highly/partially intelligible speech. Add Rust assertions:

```rust
assert_eq!(
    serde_json::from_str::<Intelligibility>(r#""intelligible""#).unwrap(),
    Intelligibility::HighlyIntelligible
);
assert_eq!(
    serde_json::to_string(&Intelligibility::HighlyIntelligible).unwrap(),
    r#""highly_intelligible""#
);
```

Add TSV coverage that importing legacy `intelligible` succeeds and exporting it produces `highly_intelligible`. Add a persistence golden-data test proving an existing schema-1 project with `intelligible` loads and reserializes canonically.

- [ ] **Step 2: Enter the pre-commit gate and verify RED**

Run:

```powershell
bun x vitest run src/lib/domain/project.test.ts src/lib/domain/validation.test.ts src/lib/domain/importTsv.test.ts src/App.test.ts
cargo test --manifest-path src-tauri/Cargo.toml intelligibility
cargo test --manifest-path src-tauri/Cargo.toml tsv
```

Expected: FAIL because `highly_intelligible` and `HighlyIntelligible` do not exist and legacy normalization is absent.

- [ ] **Step 3: Implement canonical values and aliases**

Use this TypeScript normalizer:

```ts
export function normalizeIntelligibility(value: Intelligibility | 'intelligible'): Intelligibility {
  return value === 'intelligible' ? 'highly_intelligible' : value;
}
```

Apply it to imported portable rows and recovered project annotations/drafts before validation. Change defaults and speech normalization to `highly_intelligible`. In Rust replace the variant with:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Intelligibility {
    #[serde(alias = "intelligible")]
    HighlyIntelligible,
    PartiallyIntelligible,
    Unintelligible,
    NotApplicable,
}
```

Update bridge types, fixtures, golden JSON, native constructors, and expected TSV strings. Do not increment schema version.

- [ ] **Step 4: Verify GREEN and commit immediately**

Run:

```powershell
bun x vitest run src/lib/domain/project.test.ts src/lib/domain/validation.test.ts src/lib/domain/importTsv.test.ts src/App.test.ts
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: frontend selections pass; all Rust unit/integration tests pass; clippy reports no warnings.

Commit:

```powershell
git add src src-tauri tests/fixtures
git commit -m "feat: canonicalize intelligibility values"
```

### Task 3: Searchable Acoustic Tags and Selection Inspector

**Files:**
- Create: `src/lib/components/AcousticTagSelect.svelte`
- Create: `src/lib/components/AcousticTagSelect.test.ts`
- Modify: `src/lib/components/AnnotationDashboard.svelte`
- Modify: `src/lib/components/AnnotationDashboard.test.ts`
- Modify: `src/app.css`

**Interfaces:**
- Produces `AcousticTagSelect` props `{ tags: LabelDefinition[]; selectedIds: string[]; disabled?: boolean; onchange(ids: string[]): void }`.
- Keeps `AnnotationDashboard` props `{ store: ProjectStore; disabled?: boolean }` so App integration remains stable until Task 6.
- Consumes `stableColorSlot` and semantic tag/status/speaker CSS slots from Task 1.

- [ ] **Step 1: Write dropdown and inspector tests first**

Cover these observable behaviors:

```ts
await fireEvent.click(screen.getByRole('combobox', { name: 'Acoustic tags' }));
await fireEvent.input(screen.getByRole('searchbox', { name: 'Search acoustic tags' }), {
  target: { value: 'bre' }
});
expect(screen.getByRole('option', { name: 'breath' })).toBeVisible();
await fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });
await fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
expect(onchange).toHaveBeenCalledWith(['breath-id']);
```

Also assert Escape closes the popup, selected chips can be removed, clicking outside closes it, and disabled state prevents changes. Update dashboard tests to assert managers are absent, the inspector has a Transcription field and formatted duration, all four human-readable intelligibility labels exist, plain Enter submits, Shift+Enter inserts a line break, IME Enter does not submit, and invalid boundary pairs remain local.

- [ ] **Step 2: Enter the pre-commit gate and verify RED**

Run:

```powershell
bun x vitest run src/lib/components/AcousticTagSelect.test.ts src/lib/components/AnnotationDashboard.test.ts
```

Expected: FAIL because `AcousticTagSelect.svelte` does not exist and the dashboard still renders checkbox/tag-manager lists and legacy inspector structure.

- [ ] **Step 3: Implement the listbox and inspector**

Implement a button with `role="combobox"`, `aria-expanded`, `aria-controls`, and `aria-haspopup="listbox"`; a popup search input; and options with `role="option"` plus `aria-selected`. Maintain `open`, `query`, and active-index state; ArrowUp/ArrowDown move the active option, Enter toggles it, and Escape closes. Keep selected IDs in project order and call `onchange` with a new array.

Rewrite `AnnotationDashboard.svelte` as the right-hand Selection inspector while retaining its boundary context key and `completeBoundaryEdit` algorithm. Replace tag checkboxes with `AcousticTagSelect`. Remove `SpeakerManager` and `AcousticTagManager` imports. Render canonical values with these labels:

```ts
const intelligibilityOptions = [
  ['highly_intelligible', 'Highly intelligible'],
  ['partially_intelligible', 'Partially intelligible'],
  ['unintelligible', 'Unintelligible'],
  ['not_applicable', 'Not applicable']
] as const;
```

Keep the existing `onEditorKeydown` guard exactly equivalent to `event.key === 'Enter' && !event.shiftKey && !event.isComposing`.

- [ ] **Step 4: Verify GREEN and commit immediately**

Run:

```powershell
bun x vitest run src/lib/components/AcousticTagSelect.test.ts src/lib/components/AnnotationDashboard.test.ts src/lib/state/projectStore.test.ts
bun run check
```

Expected: all selected tests pass and Svelte reports 0 errors and 0 warnings.

Commit:

```powershell
git add src/lib/components/AcousticTagSelect.svelte src/lib/components/AcousticTagSelect.test.ts src/lib/components/AnnotationDashboard.svelte src/lib/components/AnnotationDashboard.test.ts src/app.css
git commit -m "feat: build the selection inspector"
```

### Task 4: Settings Dialog and Project Label Management

**Files:**
- Create: `src/lib/components/SettingsDialog.svelte`
- Create: `src/lib/components/SettingsDialog.test.ts`
- Modify: `src/lib/components/SpeakerManager.svelte`
- Modify: `src/lib/components/AcousticTagManager.svelte`
- Modify: `src/lib/components/LabelManager.test.ts`
- Modify: `src/lib/components/ClipToolbar.svelte`
- Modify: `src/lib/components/ClipToolbar.test.ts`
- Modify: `src/app.css`

**Interfaces:**
- Produces `SettingsDialog` props `{ store: ProjectStore | null; palette: PaletteId; multilinePolicy: MultilinePolicy; disabled?: boolean; onpalette(value: PaletteId): void; onpolicy(value: MultilinePolicy): void; onclose(): void }`.
- Changes `ClipToolbar.Actions` to add `openSettings(): void` and removes `setMultilinePolicy`; removes the `multilinePolicy` prop from the toolbar.
- Consumes `PaletteSelector`, existing manager/store mutation APIs, and the existing async export-policy callback supplied later by App.

- [ ] **Step 1: Write settings and toolbar tests first**

`SettingsDialog.test.ts` must assert `role="dialog"`, accessible title Settings, Appearance/Project labels/Export sections, four palette radios, speaker and acoustic-tag management only when a project exists, multiline policy selection, Escape close, close-button behavior, and focus moving into the dialog. Update manager tests to exercise the same add/rename/remove/reassign behavior inside Settings. Update toolbar tests to assert the logo/title and Settings button, and to assert that multiline policy is no longer in the toolbar.

- [ ] **Step 2: Enter the pre-commit gate and verify RED**

Run:

```powershell
bun x vitest run src/lib/components/SettingsDialog.test.ts src/lib/components/LabelManager.test.ts src/lib/components/ClipToolbar.test.ts
```

Expected: FAIL because the dialog does not exist and toolbar/manager placement still follows the old contract.

- [ ] **Step 3: Implement the modal and compact toolbar**

Render Settings conditionally as a native `<dialog open aria-labelledby="settings-title">` with a backdrop wrapper, close button, section navigation, and an Escape key handler. Put `PaletteSelector` in Appearance, the existing managers in Project labels, and this exact export select in Export:

```svelte
<select aria-label="Multiline export policy" value={multilinePolicy} disabled={disabled}
  onchange={(event) => onpolicy((event.currentTarget as HTMLSelectElement).value as MultilinePolicy)}>
  <option value="escape">Escape line breaks as \n</option>
  <option value="space">Replace line breaks with spaces</option>
  <option value="quoted">Preserve line breaks in quoted fields</option>
</select>
```

Keep manager mutation methods unchanged, but give their sections compact row markup and explicit field labels. Rebuild `ClipToolbar` with an inline accessible waveform mark, visible Lightscribe title, flexible filename, existing playback controls, Import/Export, and Settings. Keep analysis progress in a separate `.analysis-status` row emitted beneath the main toolbar content.

- [ ] **Step 4: Verify GREEN and commit immediately**

Run:

```powershell
bun x vitest run src/lib/components/SettingsDialog.test.ts src/lib/components/LabelManager.test.ts src/lib/components/ClipToolbar.test.ts
bun run check
```

Expected: all selected tests pass and Svelte reports 0 errors and 0 warnings.

Commit:

```powershell
git add src/lib/components/SettingsDialog.svelte src/lib/components/SettingsDialog.test.ts src/lib/components/SpeakerManager.svelte src/lib/components/AcousticTagManager.svelte src/lib/components/LabelManager.test.ts src/lib/components/ClipToolbar.svelte src/lib/components/ClipToolbar.test.ts src/app.css
git commit -m "feat: move project controls into settings"
```

### Task 5: Rich Continuously Scrollable Annotation List

**Files:**
- Modify: `src/lib/components/AnnotationTable.svelte`
- Modify: `src/lib/components/AnnotationTable.test.ts`
- Modify: `src/app.css`

**Interfaces:**
- Produces and exports `AnnotationRow` with `id`, `startMs`, `endMs`, `speakerId`, `speaker`, `transcription`, `tags`, and `intelligibility`.
- `AnnotationTable` props become `{ annotations: AnnotationRow[]; activeId?: string | null; format: TimeDisplayFormat; disabled?: boolean; onselect(id): void; onremove(id): void }`.
- Consumes `formatTime` and `stableColorSlot`.

- [ ] **Step 1: Write the full list behavior tests first**

Use at least twelve rows and assert chronological ordering, overlap preservation, column headers, formatted times, transcript fallback, speaker dots/rails, tag chips, intelligibility labels/icons, independent Edit and Remove buttons, `aria-current` on the selected row, and the absence of page controls. Set `scrollTop` on the list viewport, rerender with an updated active row, and assert the same element retains its scroll position.

- [ ] **Step 2: Enter the pre-commit gate and verify RED**

Run:

```powershell
bun x vitest run src/lib/components/AnnotationTable.test.ts
```

Expected: FAIL because the existing three-column button rows have no headers, tag/status data, or scroll viewport contract.

- [ ] **Step 3: Implement the table-like list**

Export this row shape:

```ts
export interface AnnotationRow {
  id: string;
  startMs: number;
  endMs: number;
  speakerId: string | null;
  speaker: string;
  transcription: string;
  tags: { id: string; label: string }[];
  intelligibility: Intelligibility;
}
```

Use a semantic section and grid rows rather than a native table so the independent edit/remove controls remain valid and the responsive column layout can truncate text. Put rows in `.annotation-list-scroll`, headers in a sticky `.annotation-list-header`, and do not key or remount the scroll viewport when `activeId` changes. Use `data-color-slot` values from `stableColorSlot` for speakers/tags and readable text for every intelligibility value.

- [ ] **Step 4: Verify GREEN and commit immediately**

Run:

```powershell
bun x vitest run src/lib/components/AnnotationTable.test.ts
bun run check
```

Expected: the component tests pass and Svelte reports 0 errors and 0 warnings.

Commit:

```powershell
git add src/lib/components/AnnotationTable.svelte src/lib/components/AnnotationTable.test.ts src/app.css
git commit -m "feat: add the scrollable annotation list"
```

### Task 6: App Integration, Responsive Styling, and Window Contract

**Files:**
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`
- Modify: `src/app.css`
- Modify: `src/lib/components/TimelineWorkspace.svelte`
- Modify: `src/lib/components/TimelineWorkspace.test.ts`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src/task15.configuration.test.ts`
- Modify: `tests/e2e/lightscribe.spec.ts`

**Interfaces:**
- App owns `palette: PaletteId`, `settingsOpen: boolean`, and the existing async multiline-policy mutation.
- App passes the expanded `AnnotationRow[]`, `displayFormat`, settings callbacks, and existing store callbacks into Tasks 3-5 components.
- No native bridge or playback interface changes.

- [ ] **Step 1: Write integration and responsive-contract tests first**

Extend App tests to assert Settings opens/closes, palette selection calls `persistPalette`, label managers exist only in Settings, table row selection updates the inspector, and new selection versus active annotation chooses Add versus Update. Extend the configuration test to require initial `width: 1280`, `minWidth: 1280`, and `height: 800`. Extend E2E to assert the 1280px viewport has no horizontal overflow, the saved list scrolls without pagination, a selected annotation loads the inspector, the acoustic dropdown selects a tag, Enter updates, Settings switches palette, and the chosen `data-palette` survives a reload.

- [ ] **Step 2: Enter the final feature pre-commit gate and verify RED**

Run:

```powershell
bun x vitest run src/App.test.ts src/lib/components/TimelineWorkspace.test.ts src/task15.configuration.test.ts
bun run test:e2e
```

Expected: FAIL because App has not integrated the new contracts, the Tauri window still opens at 900x600, and the approved responsive layout is absent.

- [ ] **Step 3: Integrate components and complete styling**

Initialize appearance without project persistence:

```ts
let palette = $state<PaletteId>(loadPalette(localStorage));
let settingsOpen = $state(false);
function changePalette(value: PaletteId): void {
  palette = value;
  persistPalette(value);
}
```

Map table rows with stable IDs and labels:

```ts
const tableAnnotations = project.annotations.map((annotation) => ({
  id: annotation.id,
  startMs: annotation.startMs,
  endMs: annotation.endMs,
  speakerId: annotation.speakerId,
  speaker: project.speakers.find((speaker) => speaker.id === annotation.speakerId)?.label ?? 'none',
  transcription: annotation.transcription,
  tags: annotation.acousticTagIds.flatMap((id) => {
    const tag = project.acousticTags.find((item) => item.id === id);
    return tag ? [tag] : [];
  }),
  intelligibility: annotation.intelligibility
}));
```

Compose Timeline above `.lower-workspace`, with AnnotationTable left and AnnotationDashboard right. Render `SettingsDialog` at app-shell level. Move all literal UI colors to semantic variables, style custom inputs/selects/range/checkbox/listbox/dialog/scrollbars, add focus-visible and reduced-motion rules, and keep only the annotation list, inspector body, tag listbox, settings body, and timeline as intentional scroll containers. Add the zoom hint without changing timeline layer order or wheel logic. Set Tauri window width/minimum/height to 1280/1280/800.

- [ ] **Step 4: Run complete GREEN verification and commit immediately**

Run:

```powershell
bun run verify
bun run test:e2e
bun tauri build
```

Expected: all frontend tests, Svelte checks, production bundle assertions, Rust format/clippy/tests, two end-to-end tests, and the packaged Tauri build succeed with no warnings or failures.

Commit:

```powershell
git add src src-tauri/tauri.conf.json tests/e2e/lightscribe.spec.ts
git commit -m "feat: deliver the Lightscribe workspace rework"
```

### Task 7: Visual Verification and Documentation Synchronization

**Files:**
- Modify: `docs/superpowers/specs/2026-07-18-lightscribe-design.md`
- Modify: `README.md`
- Modify: tests only if visual verification exposes a reproducible defect, with the failing regression test written first

**Interfaces:**
- No new production interface. This task synchronizes the original product specification and performs the final 1280px/1600px browser inspection.

- [ ] **Step 1: Update the original product specification**

Replace its legacy intelligibility vocabulary and basic stacked-dashboard description with links to `2026-07-19-lightscribe-ui-rework-design.md`. Record the four palettes, application-global persistence, 1280px window contract, Settings ownership of labels/export policy, and continuously scrollable annotation list.

- [ ] **Step 2: Enter the documentation pre-commit verification gate**

Run the production test-mode preview and inspect 1280x800 and 1600x1000 with Playwright. Confirm no uncaught errors, error overlays, horizontal overflow, clipped controls, missing focus outlines, native unstyled select/checkbox/scrollbar remnants, or pagination controls. Exercise Open fixture, loop selection, Ctrl+wheel zoom, tag dropdown, Add/Update via Enter, Settings, all four palettes, label rename, and TSV controls.

If a defect is found, add the smallest failing automated regression test, run it to confirm RED, fix it, and rerun that test before the commands below.

- [ ] **Step 3: Verify and commit immediately**

Run:

```powershell
git diff --check
bun run verify
bun run test:e2e
```

Expected: clean diff check, complete verification green, and both E2E tests green.

Commit:

```powershell
git add docs README.md src tests
git commit -m "docs: synchronize the Lightscribe UI contract"
```
