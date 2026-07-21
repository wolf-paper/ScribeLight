# Transcription and Waveform QoL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move transcription entry above the saved-annotation list, show saved annotations as passive waveform regions, preview rows visually on hover/focus, and activate annotations by clicking their rows.

**Architecture:** A new `ActiveTextEditor.svelte` reads and updates the existing `ProjectStore` draft while the Selection inspector retains metadata and actions. `AnnotationTable.svelte` emits activation and ephemeral preview intent, `App.svelte` owns the preview ID, and the existing WaveSurfer Regions adapter diffs passive regions by stable annotation ID alongside its canonical editable selection and one transient preview region.

**Tech Stack:** Svelte 5, TypeScript, Vitest, Testing Library, WaveSurfer.js Regions, Playwright, Tauri 2, Rust.

## Global Constraints

- Work only in the primary checkout at `C:\Users\squnk\source\repos\wolf-paper\lightscribe` on `feature/transcription-qol`; do not create or use a `.worktrees` checkout.
- Preserve the Rust playback engine, 1 ms boundary model, loop behavior, Ctrl+wheel zoom, TSV format, project persistence schema, palette selection, and 1280 px minimum-width layout.
- Move only the Transcription textarea out of the Selection inspector. Boundaries, speaker, event type, intelligibility, overlap, confidence, acoustic tags, Notes, and Add/Update/Remove/Clear remain in the inspector.
- Plain Enter submits, Shift+Enter inserts a newline, and composing Enter does nothing.
- Hover/focus preview is visual-only: it never mutates selection, draft, playback, persistence, or waveform callbacks.
- Passive and preview waveform regions are non-interactive and cannot block loop handles or drag selection.
- Keep the saved-annotation list continuous and scrollable; do not introduce pagination, search, filters, waveform labels, or speaker-colored regions.
- Use test-first logic. Prepare focused tests first, run the focused RED immediately before implementation, implement the minimum GREEN, run the focused GREEN, self-review, and commit without extra intervening test runs.
- Every implementation task requires an independent spec-and-quality review before the next task. Run the complete verification, E2E, and packaged Tauri build immediately before the final implementation commit.

---

### Task 1: Extract the Active Transcription Editor

**Files:**
- Create: `src/lib/components/ActiveTextEditor.svelte`
- Create: `src/lib/components/ActiveTextEditor.test.ts`
- Modify: `src/lib/components/AnnotationDashboard.svelte`
- Modify: `src/lib/components/AnnotationDashboard.test.ts`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`
- Modify: `src/app.css`
- Modify: `src/task15.configuration.test.ts`

**Interfaces:**
- Consumes: `ProjectStore.patchDraft({ transcription })`, `ProjectStore.commitDraft()`, `$store.project`, and the existing `disabled` mutation guard.
- Produces: `ActiveTextEditor.svelte` props `{ store: ProjectStore; disabled?: boolean }` and `.annotation-column` layout for Tasks 2 and 4.

- [ ] **Step 1: Write the editor and extraction tests without changing production code**

Create `ActiveTextEditor.test.ts` with this real-store fixture and the assertions below:

```ts
function setupStore(): ProjectStore {
  const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) }, () => 'event-1');
  const project = createProject({
    canonicalPath: 'a.wav', size: 1, modifiedMs: 1,
    durationMs: 1_000, sampleRate: 1_000, channels: 1
  });
  store.open(project);
  store.patchDraft({ startMs: 10, endMs: 20, transcription: 'draft text' });
  return store;
}

const store = setupStore();
render(ActiveTextEditor, { store });
const editor = screen.getByRole('textbox', { name: 'Transcription' });

expect(screen.getByRole('region', { name: 'Transcription editor' })).toContainElement(editor);
await fireEvent.input(editor, { target: { value: 'updated text' } });
expect(get(store).project?.draft.transcription).toBe('updated text');
await fireEvent.keyDown(editor, { key: 'Enter' });
expect(get(store).project?.annotations).toHaveLength(1);
```

Add separate tests that prove Shift+Enter is not prevented and does not submit, composing Enter does not submit, and `disabled: true` disables the textarea and prevents input/submission. Move the existing transcription keyboard tests out of `AnnotationDashboard.test.ts`; change its layout assertion to `queryByLabelText('Transcription')` being absent while Notes and the actions remain present.

Update the App layout test to require:

```ts
expect(lowerWorkspace?.children[0]).toHaveClass('annotation-column');
expect(lowerWorkspace?.children[1]).toHaveClass('annotation-dashboard');
expect(lowerWorkspace?.querySelector('.annotation-column')?.children[0]).toHaveClass('active-text-editor');
expect(lowerWorkspace?.querySelector('.annotation-column')?.children[1]).toHaveClass('annotation-table');
```

Extend `task15.configuration.test.ts` to require a two-row annotation column with a bounded editor row and `minmax(0, 1fr)` list row.

- [ ] **Step 2: Run the focused RED gate**

Run:

```powershell
bun run test -- src/lib/components/ActiveTextEditor.test.ts src/lib/components/AnnotationDashboard.test.ts src/App.test.ts src/task15.configuration.test.ts
```

Expected: FAIL because `ActiveTextEditor.svelte` and `.annotation-column` do not exist and the inspector still renders Transcription.

- [ ] **Step 3: Add the minimal editor component and compose it in App**

Create `ActiveTextEditor.svelte` with this behavior:

```svelte
<script lang="ts">
  import type { ProjectStore } from '../state/projectStore';

  export let store: ProjectStore;
  export let disabled = false;

  function submit(event: KeyboardEvent): void {
    if (disabled || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void store.commitDraft();
  }

  function update(event: Event): void {
    if (!disabled) store.patchDraft({ transcription: (event.currentTarget as HTMLTextAreaElement).value });
  }
</script>

{#if $store.project}
  <section class="active-text-editor" aria-label="Transcription editor">
    <h2>Transcription</h2>
    <fieldset {disabled}>
      <textarea
        aria-label="Transcription"
        rows="4"
        value={$store.project.draft.transcription}
        on:input={update}
        on:keydown={submit}
      ></textarea>
    </fieldset>
  </section>
{/if}
```

Remove the Transcription label/textarea from `AnnotationDashboard.svelte`; retain its submit handler for Notes and inspector actions. Import and render `ActiveTextEditor` in `App.svelte`:

```svelte
<div class="lower-workspace">
  <div class="annotation-column">
    <ActiveTextEditor store={projectStore} disabled={transitionBusy} />
    <AnnotationTable
      annotations={tableAnnotations}
      activeId={project.activeAnnotationId}
      format={project.displayFormat}
      disabled={transitionBusy}
      onselect={(annotationId) => { if (!transitionBusy) projectStore.selectAnnotation(annotationId); }}
      onremove={(annotationId) => { if (!transitionBusy) void projectStore.removeAnnotation(annotationId); }}
    />
  </div>
  <AnnotationDashboard store={projectStore} disabled={transitionBusy} />
</div>
```

Add CSS that keeps the list dominant and scrollable:

```css
.annotation-column {
  display: grid;
  grid-template-rows: minmax(7.5rem, auto) minmax(0, 1fr);
  gap: .7rem;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.active-text-editor { min-width: 0; color: var(--color-text-primary); background: var(--color-panel); border: 1px solid var(--color-border); border-radius: .35rem; }
.active-text-editor h2 { margin: 0; padding: .55rem .75rem; background: var(--color-toolbar); border-bottom: 1px solid var(--color-border); font-size: .9rem; }
.active-text-editor fieldset { margin: 0; padding: .65rem .75rem; border: 0; }
.active-text-editor textarea { width: 100%; min-height: 4.5rem; resize: vertical; }
```

- [ ] **Step 4: Run the focused GREEN gate and inspect the diff**

Run the Step 2 command again. Expected: all selected files pass with no Svelte warnings. Then run `git diff --check` and inspect the task diff for accidental inspector/control changes.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- src/lib/components/ActiveTextEditor.svelte src/lib/components/ActiveTextEditor.test.ts src/lib/components/AnnotationDashboard.svelte src/lib/components/AnnotationDashboard.test.ts src/App.svelte src/App.test.ts src/app.css src/task15.configuration.test.ts
git commit -m "feat: add the active transcription editor"
```

---

### Task 2: Replace Edit Buttons with Row Activation and Preview Intent

**Files:**
- Modify: `src/lib/components/AnnotationTable.svelte`
- Modify: `src/lib/components/AnnotationTable.test.ts`
- Modify: `src/App.test.ts`
- Modify: `src/app.css`
- Modify: `tests/e2e/lightscribe.spec.ts`

**Interfaces:**
- Consumes: existing `onselect(id)` and `onremove(id)` callbacks.
- Produces: `AnnotationTable` prop `onpreview?: (id: string | null) => void`, accessible row activation, and preview events for Task 4.

- [ ] **Step 1: Replace button-centric tests with row interaction tests**

Update `renderTable` to accept spies for `onselect`, `onremove`, and `onpreview`. Assert that the row named `Activate annotation First note`:

```ts
await fireEvent.pointerEnter(firstRow);
expect(preview).toHaveBeenLastCalledWith('first');
await fireEvent.pointerLeave(firstRow);
expect(preview).toHaveBeenLastCalledWith(null);

await fireEvent.focusIn(firstRow);
expect(preview).toHaveBeenLastCalledWith('first');
await fireEvent.keyDown(firstRow, { key: 'Enter' });
await fireEvent.keyDown(firstRow, { key: ' ', code: 'Space' });
expect(select).toHaveBeenNthCalledWith(1, 'first');
expect(select).toHaveBeenNthCalledWith(2, 'first');
```

Add a combined-source test: focus a row, enter and leave it with the pointer, and confirm pointer leave falls back to the focused row instead of emitting `null`. Add a direct row-click test. Click the nested Remove button and assert `remove('first')` occurs while `select` does not. Rerender disabled and assert rows have `aria-disabled="true"`, no tab stop, no preview, and no activation. Assert no Edit button exists and the active row itself has `aria-current="true"`.

Update the App test to click the saved row rather than an Edit button. Update the existing E2E row-selection line to click the row; the full browser suite remains reserved for Task 4's final gate.

- [ ] **Step 2: Run the focused RED gate**

Run:

```powershell
bun run test -- src/lib/components/AnnotationTable.test.ts src/App.test.ts
```

Expected: FAIL because rows are not interactive, Edit still exists, and no preview callback is emitted.

- [ ] **Step 3: Implement row interaction with combined preview sources**

Extend the props and add event-state helpers:

```ts
onpreview?: (id: string | null) => void;

let pointerPreviewId: string | null = null;
let focusPreviewId: string | null = null;
let publishedPreviewId: string | null = null;

function publishPreview(): void {
  const next = disabled ? null : pointerPreviewId ?? focusPreviewId;
  if (next === publishedPreviewId) return;
  publishedPreviewId = next;
  onpreview?.(next);
}

function activate(id: string): void {
  if (!disabled) onselect(id);
}
```

Give each row `tabindex={disabled ? undefined : 0}`, `aria-disabled`, `aria-current`, `aria-label`, click, Enter/Space, pointer-enter/leave, and focus-in/out handlers. Ignore bubbled row keyboard events whose `event.target !== event.currentTarget`. Prevent Space scrolling. Resolve `event.relatedTarget?.closest('.annotation-row')?.dataset.annotationId` when pointer or focus leaves a row so direct row-to-row movement publishes the destination ID without an intermediate `null`; moving to a child within the same row retains the same ID, and moving outside all rows clears it. Add a reactive disabled guard that clears both preview sources and publishes `null` once if the table becomes disabled. Remove the Edit button. Stop propagation in the Remove handler before calling `onremove`.

Update the Actions header to singular `Action`. Add pointer/focus styling without removing the active cue:

```css
.annotation-row:not([aria-disabled="true"]) { cursor: pointer; }
.annotation-row:hover:not([aria-disabled="true"]),
.annotation-row:focus-visible { background: color-mix(in srgb, var(--color-accent) 10%, var(--color-panel)); }
.annotation-row:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
.annotation-row.active { background: var(--color-selection-wash); box-shadow: inset 3px 0 0 var(--color-accent); }
```

- [ ] **Step 4: Run the focused GREEN gate and inspect the diff**

Run the Step 2 command again. Expected: all selected tests pass. Run `git diff --check`; confirm Remove cannot bubble into activation and pointer/focus precedence is explicit.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- src/lib/components/AnnotationTable.svelte src/lib/components/AnnotationTable.test.ts src/App.test.ts src/app.css tests/e2e/lightscribe.spec.ts
git commit -m "feat: activate annotations from the list"
```

---

### Task 3: Add Passive and Preview Regions to the WaveSurfer Adapter

**Files:**
- Modify: `src/lib/waveform/wavesurferAdapter.ts`
- Modify: `src/lib/waveform/wavesurferAdapter.test.ts`
- Modify: `src/lib/components/WaveformView.test.ts`
- Modify: `src/App.test.ts`
- Modify: `src/app.css`
- Modify: `src/task15.configuration.test.ts`

**Interfaces:**
- Produces: `WaveformAnnotation { id: string; startMs: number; endMs: number }`.
- Produces: `WaveformAdapter.setAnnotations(annotations: readonly WaveformAnnotation[])` and `WaveformAdapter.setPreviewAnnotation(annotationId: string | null)`.
- Preserves: `setSelection`, `setPlayhead`, `setZoom`, `destroy`, and the factory signature.

- [ ] **Step 1: Extend the adapter double and write focused region-lifecycle tests**

Give each `RegionDouble` an `element: HTMLDivElement`, make `remove()` remove that element, and keep an ordered record of created regions. Add semantic palette tokens to the mocked computed style:

```ts
'--color-annotation-region': 'rgb(40 41 42 / .12)',
'--color-annotation-preview': 'rgb(40 41 42 / .42)'
```

Add tests that prove:

```ts
adapter.setAnnotations([
  { id: 'a', startMs: 100, endMs: 300 },
  { id: 'b', startMs: 200, endMs: 400 }
]);
fixture.waveListeners.get('ready')?.();

const passive = fixture.regions.addRegion.mock.results
  .map(({ value }) => value as RegionDouble)
  .filter(({ element }) => element.dataset.lightscribeRegion === 'annotation');
expect(passive).toHaveLength(2);
expect(passive[0].options).toMatchObject({ start: .1, end: .3, drag: false, resize: false });
expect(passive[0].region.element.style.pointerEvents).toBe('none');
```

Then call `setAnnotations` with `a` moved, `b` removed, and `c` added. Assert `a` keeps object identity and receives new boundaries, `b.remove()` runs once, and only `c` is newly created. Assert none of those changes call `onchange` or remove the canonical selection.

Add preview tests that call `setPreviewAnnotation('a')`, switch to `c`, and clear. Require at most one region with `data-lightscribe-region="preview"`, require `pointer-events: none`, and require it to render above the passive/canonical layers without changing selection boundaries. Add tests for preview removal when its annotation disappears, programmatic region events being ignored, palette updates recoloring all three region classes in place, pending data before ready, and idempotent destruction.

Add empty `setAnnotations` and `setPreviewAnnotation` spies to WaveformView/App test doubles so the new required interface typechecks before Task 4 forwards values.

- [ ] **Step 2: Run the focused RED gate**

Run:

```powershell
bun run test -- src/lib/waveform/wavesurferAdapter.test.ts src/task15.configuration.test.ts
```

Expected: FAIL because the adapter has no annotation/preview API or palette tokens.

- [ ] **Step 3: Implement stable managed regions**

Extend the public types:

```ts
export interface WaveformAnnotation {
  id: string;
  startMs: number;
  endMs: number;
}

export interface WaveformAdapter {
  setSelection(selection: Selection | null): void;
  setAnnotations(annotations: readonly WaveformAnnotation[]): void;
  setPreviewAnnotation(annotationId: string | null): void;
  setPlayhead(milliseconds: number): void;
  setZoom(pixelsPerSecond: number): void;
  destroy(): void;
}
```

Extend `WaveformPalette` and `resolvePalette` with `annotation` and `annotationPreview`. Add stable internal IDs `lightscribe-annotation-${encodeURIComponent(id)}` and `lightscribe-annotation-preview`. Track:

```ts
let desiredAnnotations: readonly WaveformAnnotation[] = [];
let desiredPreviewAnnotationId: string | null = null;
const annotationRegions = new Map<string, ReturnType<typeof regions.addRegion>>();
let previewRegion: ReturnType<typeof regions.addRegion> | null = null;
```

Implement `applyAnnotations()` as an ID diff: remove missing map entries, update retained regions with start/end/color, add new non-drag/non-resize regions, mark their elements with `data-lightscribe-region="annotation"` and `data-annotation-id`, set `pointerEvents = 'none'`, and assign the passive z-index. Implement `applyPreview()` from the desired annotation summary, using one non-interactive region marked `data-lightscribe-region="preview"`; update in place for the same ID and remove/recreate only when the preview identity changes. Mark the canonical element as `data-lightscribe-region="selection"` with a middle z-index; preview is topmost.

Replace `regions.clearRegions()` in selection clearing with removal of only the canonical region. Wrap every programmatic add/update/remove in the existing `syncing` guard. Region listeners must recognize mapped/passive and preview objects and never promote or report them. Palette application updates WaveSurfer plus canonical, passive, and preview colors in place. Ready applies annotations, selection, preview, playhead, and zoom; destroy clears maps/references and then performs existing listener/observer/WaveSurfer cleanup once.

Add these exact palette tokens for Ion Magenta, Arctic Steel, Ultraviolet Grid, and Crimson Scope:

```css
:root {
  --color-annotation-region: rgb(239 91 173 / .12);
  --color-annotation-preview: rgb(239 91 173 / .44);
}
:root[data-palette="arctic-steel"] {
  --color-annotation-region: rgb(56 189 248 / .12);
  --color-annotation-preview: rgb(56 189 248 / .44);
}
:root[data-palette="ultraviolet-grid"] {
  --color-annotation-region: rgb(185 120 246 / .12);
  --color-annotation-preview: rgb(185 120 246 / .44);
}
:root[data-palette="crimson-scope"] {
  --color-annotation-region: rgb(255 100 124 / .12);
  --color-annotation-preview: rgb(255 100 124 / .44);
}
```

Extend `task15.configuration.test.ts` to require both tokens in the root and all three named palette overrides.

- [ ] **Step 4: Run the focused GREEN gate and inspect the diff**

Run the Step 2 command again. Expected: all selected tests pass. Run `git diff --check`; confirm selection clearing never calls `clearRegions`, managed regions cannot emit selection changes, and no adapter/plugin recreation occurs during annotation or palette updates.

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- src/lib/waveform/wavesurferAdapter.ts src/lib/waveform/wavesurferAdapter.test.ts src/lib/components/WaveformView.test.ts src/App.test.ts src/app.css src/task15.configuration.test.ts
git commit -m "feat: render saved waveform regions"
```

---

### Task 4: Connect List Preview to the Waveform and Verify the Complete Flow

**Files:**
- Modify: `src/lib/components/WaveformView.svelte`
- Modify: `src/lib/components/WaveformView.test.ts`
- Modify: `src/lib/components/TimelineWorkspace.svelte`
- Modify: `src/lib/components/TimelineWorkspace.test.ts`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`
- Modify: `src/task15.configuration.test.ts`
- Modify: `tests/e2e/lightscribe.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 2 `AnnotationTable.onpreview` and Task 3 `WaveformAnnotation`, `setAnnotations`, and `setPreviewAnnotation`.
- Produces: end-to-end state flow from pointer/focus preview to WaveSurfer and click activation to `ProjectStore.selectAnnotation`.

- [ ] **Step 1: Write forwarding and App integration tests**

Extend `WaveformView.test.ts` props with two overlapping summaries and `previewAnnotationId: 'b'`. Require both methods on the first adapter and, after changing peaks, on the replacement adapter:

```ts
expect(first.setAnnotations).toHaveBeenCalledWith(annotations);
expect(first.setPreviewAnnotation).toHaveBeenCalledWith('b');
expect(second.setAnnotations).toHaveBeenCalledWith(updatedAnnotations);
expect(second.setPreviewAnnotation).toHaveBeenCalledWith(null);
```

In `TimelineWorkspace.test.ts`, mock `createWaveformAdapter` with a hoisted adapter double containing all six adapter methods. Render `peaks`, annotations, and preview ID and assert the double receives both new values without altering the four timeline layers or Ctrl+wheel behavior.

Add an App integration test with two saved overlapping annotations. After opening:

```ts
expect(waveformSpies.setAnnotations).toHaveBeenCalledWith([
  { id: 'first', startMs: 1_000, endMs: 2_000 },
  { id: 'second', startMs: 1_500, endMs: 2_500 }
]);
```

Pointer-enter the second row and require `setPreviewAnnotation('second')` while the start/end inputs, active row, audio loop calls, and saved project are unchanged. Pointer-leave and require `null`. Click the row and require the second annotation to become active, its draft text/range to load, and the Update action to appear. Add a removal case that clears a previewed ID.

Update the E2E story after the seeded rows are removed: require two passive region elements, hover the first row, require one preview element while boundary inputs remain at their prior values, leave and require no preview, then click the row and require its 1000/2000 boundaries and transcription to load. Keep the later overlap/zoom/export/recovery assertions intact.

- [ ] **Step 2: Run the focused RED gate**

Run:

```powershell
bun run test -- src/lib/components/WaveformView.test.ts src/lib/components/TimelineWorkspace.test.ts src/App.test.ts src/task15.configuration.test.ts
```

Expected: FAIL because annotations and preview state are not forwarded or connected.

- [ ] **Step 3: Thread annotations and preview through the component tree**

Add defaulted props to `WaveformView.svelte` and call both adapter methods in its reactive synchronization block:

```ts
export let annotations: readonly WaveformAnnotation[] = [];
export let previewAnnotationId: string | null = null;

$: if (mounted && adapter) {
  adapter.setAnnotations(annotations);
  adapter.setPreviewAnnotation(previewAnnotationId);
  adapter.setSelection(selection);
  adapter.setPlayhead(playheadMs);
  adapter.setZoom(pixelsPerSecond);
}
```

Add the same defaulted props to `TimelineWorkspace.svelte` and pass them to `WaveformView`.

In `App.svelte`, add:

```ts
let previewAnnotationId = $state<string | null>(null);
let waveformAnnotations = $derived(project?.annotations.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })) ?? []);

$effect(() => {
  if (transitionBusy || !project?.annotations.some(({ id }) => id === previewAnnotationId)) {
    previewAnnotationId = null;
  }
});
```

Pass both values to `TimelineWorkspace`, and wire `AnnotationTable` with `onpreview={(id) => { if (!transitionBusy) previewAnnotationId = id; }}`. Preserve the existing `onselect` store call; row click from Task 2 now drives it. Update README feature text to mention the active transcription editor, passive waveform annotations, visual preview, and row activation without documenting internal adapter details.

- [ ] **Step 4: Run the focused GREEN gate**

Run the Step 2 command again. Expected: all selected tests pass with no Svelte warnings.

- [ ] **Step 5: Run the final pre-commit verification gate**

Run exactly once, immediately before the task commit:

```powershell
bun run verify
bun run test:e2e
bun tauri build
git diff --check
```

Expected: all frontend tests pass; Svelte reports 0 errors and 0 warnings; production fake exclusion passes; Rust format, strict Clippy, unit, and integration tests pass; both Playwright stories pass; Tauri produces the EXE, MSI, and NSIS artifacts; diff check reports no whitespace errors.

- [ ] **Step 6: Commit Task 4**

```powershell
git add -- src/lib/components/WaveformView.svelte src/lib/components/WaveformView.test.ts src/lib/components/TimelineWorkspace.svelte src/lib/components/TimelineWorkspace.test.ts src/App.svelte src/App.test.ts src/task15.configuration.test.ts tests/e2e/lightscribe.spec.ts README.md
git commit -m "feat: connect annotation previews to the waveform"
```

- [ ] **Step 7: Request whole-branch review**

Generate a review package from merge base `1e21f3e` through Task 4 HEAD. Ask the final reviewer to verify the approved design, all global constraints, passive/selection/preview layering, non-mutating hover, row accessibility and removal isolation, adapter cleanup, palette completeness, Tauri production boundaries, and the reported verification evidence. Resolve every Critical or Important finding in one consolidated fix wave, rerun only covering tests immediately before its fix commit, and re-review until clean.
