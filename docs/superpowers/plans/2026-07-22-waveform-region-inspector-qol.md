# Waveform Region and Inspector QoL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make passive waveform annotations hover-previewable and double-click activatable, and replace duplicate inspector deletion with a preserve-range new-annotation action plus a compact accessible `X` clear control.

**Architecture:** `ProjectStore` owns a new editor-only transition that detaches the active annotation while preserving its valid loop range and resetting all other draft fields. The WaveSurfer adapter owns region event subscriptions and reports typed interaction intent through a callback object; Svelte components only forward those callbacks, while `App.svelte` continues to own ephemeral preview state and delegates activation to `ProjectStore.selectAnnotation`.

**Tech Stack:** Svelte 5, TypeScript 5.6, WaveSurfer.js Regions 7.12, Vitest 4, Testing Library, Playwright, Bun, Tauri 2, Rust.

## Global Constraints

- Work only in the primary checkout at `C:\Users\squnk\source\repos\wolf-paper\lightscribe` on `feature/transcription-qol`; do not create or edit a `.worktrees` checkout.
- The approved contract is `docs/superpowers/specs/2026-07-22-waveform-region-inspector-qol-design.md`.
- Passive regions remain fixed: `drag: false` and `resize: false`.
- Passive-region hover is visual-only. It must not change the draft, active annotation, canonical selection, playback loop, recovery data, or persisted project.
- Passive-region single-click does nothing; double-click activates through `ProjectStore.selectAnnotation(id)`.
- When regions overlap, the topmost visible passive region receives pointer interaction; do not add lanes or an overlap chooser.
- The Selection inspector no longer exposes deletion. Deletion remains in the Saved annotations list.
- The active inspector action order is `Update annotation`, `Add annotation`, `X`; the inactive order is `Add annotation`, `X`.
- The visible clear glyph is exactly `X`, while its accessible name and tooltip are exactly `Clear annotation`.
- Starting a new annotation preserves the current valid loop boundaries, clears `activeAnnotationId`, resets all other draft fields to existing defaults, selects the first project speaker, and does not create or mutate a saved annotation until submission.
- No domain schema, TSV shape, audio playback API, palette definition, keyboard shortcut, dependency, or label-management behavior changes.
- Follow consolidated TDD per task: write the focused tests first, run the focused RED once, implement, run focused GREEN and the required gate immediately before that task's commit, then run no tests after the commit.

---

### Task 1: Preserve-range new draft and inspector actions

**Files:**
- Modify: `src/lib/state/projectStore.ts`
- Modify: `src/lib/state/projectStore.test.ts`
- Modify: `src/lib/components/AnnotationDashboard.svelte`
- Modify: `src/lib/components/AnnotationDashboard.test.ts`
- Modify: `src/app.css`

**Interfaces:**
- Consumes: existing `emptyDraft()`, `validDraftSelection(...)`, `ProjectStore.clearDraft()`, draft revision tracking, recovery scheduling, and `AnnotationDashboard.submitDraft()`.
- Produces: `ProjectStore.startNewDraftFromSelection(): void` for the active inspector's secondary Add action.
- Preserves: `clearDraft()` still clears both draft and selection; `submitDraft()` remains the only validating commit coordinator.

- [ ] **Step 1: Write the focused store tests before production code**

Add tests to `projectStore.test.ts` that construct a project with a real saved annotation, make it active through `selectAnnotation`, customize every non-boundary draft field, call the wished-for method, and assert the exact state:

```ts
store.selectAnnotation('saved-annotation');
store.patchDraft({
  eventType: 'speech',
  transcription: 'unsaved edit',
  intelligibility: 'unintelligible',
  speakerId: project.speakers[1].id,
  overlap: 'overlap',
  confidence: 'low',
  acousticTagIds: [project.acousticTags[0].id],
  notes: 'discard this metadata'
});

store.startNewDraftFromSelection();

expect(get(store).project).toMatchObject({
  annotations: [expect.objectContaining({ id: 'saved-annotation', transcription: 'saved text' })],
  activeAnnotationId: null,
  activeSelection: { startMs: 40, endMs: 80 },
  draft: {
    startMs: 40,
    endMs: 80,
    eventType: 'speech',
    transcription: '',
    intelligibility: 'highly_intelligible',
    speakerId: project.speakers[0].id,
    overlap: 'none',
    confidence: 'high',
    acousticTagIds: [],
    notes: ''
  }
});
expect(bridge.saveProject).not.toHaveBeenCalled();
await vi.advanceTimersByTimeAsync(300);
expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
  activeAnnotationId: null,
  activeSelection: { startMs: 40, endMs: 80 }
}));
```

Add one guard test covering each rejected state without scheduling recovery: no open project, mutations blocked, no active annotation, missing active selection, invalid/out-of-duration selection, and an orphaned `activeAnnotationId` that is absent from `annotations`. Add a concurrency test following the existing unresolved-mutation pattern: begin a `mutateProject` save, call `startNewDraftFromSelection()`, resolve the first save, run recovery timers, and assert the final persisted project retains the new-draft state and unchanged annotations.

- [ ] **Step 2: Write the focused inspector tests before production code**

Replace the inspector-removal test with an action-mode test. It must prove:

```ts
expect(screen.getByRole('button', { name: 'Add annotation' })).toBeInTheDocument();
expect(screen.getByRole('button', { name: 'Clear annotation' })).toHaveTextContent(/^X$/);
expect(screen.getByRole('button', { name: 'Clear annotation' })).toHaveAttribute('title', 'Clear annotation');
expect(screen.queryByRole('button', { name: 'Remove annotation' })).not.toBeInTheDocument();

await fireEvent.click(screen.getByRole('button', { name: 'Add annotation' }));
await screen.findByRole('button', { name: 'Update annotation' });
expect(screen.getByRole('button', { name: 'Add annotation' })).toBeInTheDocument();
expect(screen.queryByRole('button', { name: 'Remove annotation' })).not.toBeInTheDocument();

const savedBefore = structuredClone(get(store).project!.annotations);
await fireEvent.click(screen.getByRole('button', { name: 'Add annotation' }));
expect(get(store).project).toMatchObject({
  annotations: savedBefore,
  activeAnnotationId: null,
  activeSelection: { startMs: 50, endMs: 60 },
  draft: expect.objectContaining({ startMs: 50, endMs: 60, transcription: '', notes: '' })
});
expect(screen.getByRole('button', { name: 'Add annotation' })).toBeInTheDocument();
expect(screen.queryByRole('button', { name: 'Update annotation' })).not.toBeInTheDocument();
```

Rerender disabled while an annotation is active and assert both Update and secondary Add are disabled and clicking Add cannot change state. Update the existing clear assertion to click `Clear annotation`, require the visible `X`, and require `activeAnnotationId`, `activeSelection`, and draft boundaries to clear exactly as before.

- [ ] **Step 3: Run the consolidated focused RED once**

Run:

```powershell
bun run test -- src/lib/state/projectStore.test.ts src/lib/components/AnnotationDashboard.test.ts
```

Expected: the new tests fail because `startNewDraftFromSelection()` does not exist, the inspector still exposes `Remove annotation`, and the clear button is still named `Clear`.

- [ ] **Step 4: Implement `ProjectStore.startNewDraftFromSelection()`**

Add this public method beside `clearDraft()`, reusing existing revision and recovery machinery:

```ts
startNewDraftFromSelection(): void {
  if (this.mutationsBlocked) return;
  const current = get(this.state).project;
  if (!current?.activeAnnotationId || !current.activeSelection) return;
  if (!current.annotations.some(({ id }) => id === current.activeAnnotationId)) return;
  const selection = validDraftSelection(
    { ...current.draft, ...current.activeSelection },
    current.audioIdentity.durationMs
  );
  if (!selection) return;

  this.markDraftFields(draftFields);
  this.activeAnnotationRevision += 1;
  this.annotationSelection = null;
  this.updateProject((project) => ({
    ...project,
    activeAnnotationId: null,
    activeSelection: selection,
    draft: {
      ...emptyDraft(),
      ...selection,
      speakerId: project.speakers[0]?.id ?? null
    }
  }));
  this.scheduleRecovery();
}
```

Do not increment `selectionRevision`: the canonical selection is intentionally unchanged. Do mark every draft field and increment `activeAnnotationRevision` so an overlapping committed mutation cannot publish the old active annotation over this local transition.

- [ ] **Step 5: Render the revised inspector action row and compact styling**

Replace only the `.actions` block in `AnnotationDashboard.svelte`:

```svelte
<div class="actions">
  <button type="button" on:click={submitDraft}>
    {project.activeAnnotationId ? 'Update annotation' : 'Add annotation'}
  </button>
  {#if project.activeAnnotationId}
    <button type="button" on:click={() => store.startNewDraftFromSelection()}>Add annotation</button>
  {/if}
  <button
    class="clear-annotation-action"
    type="button"
    aria-label="Clear annotation"
    title="Clear annotation"
    on:click={() => store.clearDraft()}
  >X</button>
</div>
```

Keep the existing disabled fieldset so all three actions inherit transition disabling. Add compact styling in `app.css` without changing the first primary action's flex behavior:

```css
.annotation-dashboard .actions .clear-annotation-action {
  flex: 0 0 2.35rem;
  min-width: 2.35rem;
  padding-inline: 0;
  font-weight: 700;
}
```

- [ ] **Step 6: Run focused GREEN and the task gate immediately before commit**

Run:

```powershell
bun run test -- src/lib/state/projectStore.test.ts src/lib/components/AnnotationDashboard.test.ts
bun run check
git diff --check
```

Expected: all focused tests pass, Svelte reports 0 errors and 0 warnings, and the diff check exits 0. If a command fails, diagnose and fix it, then rerun this entire task gate before committing.

- [ ] **Step 7: Commit Task 1 and run no post-commit tests**

```powershell
git add -- src/lib/state/projectStore.ts src/lib/state/projectStore.test.ts src/lib/components/AnnotationDashboard.svelte src/lib/components/AnnotationDashboard.test.ts src/app.css
git commit -m "feat: streamline annotation inspector actions"
```

Record the exact RED and GREEN commands, counts, Svelte result, diff result, commit SHA, and concerns in the task report.

---

### Task 2: Interactive passive regions and application wiring

**Files:**
- Modify: `src/lib/waveform/wavesurferAdapter.ts`
- Modify: `src/lib/waveform/wavesurferAdapter.test.ts`
- Modify: `src/lib/components/WaveformView.svelte`
- Modify: `src/lib/components/WaveformView.test.ts`
- Modify: `src/lib/components/TimelineWorkspace.svelte`
- Modify: `src/lib/components/TimelineWorkspace.test.ts`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`
- Modify: `tests/e2e/lightscribe.spec.ts`
- Modify: `README.md`
- Modify: `src/task15.configuration.test.ts`

**Interfaces:**
- Consumes: Task 1 `ProjectStore.startNewDraftFromSelection()`, the existing shared `previewAnnotationId`, `ProjectStore.selectAnnotation(id)`, and WaveSurfer Regions' typed `over`, `leave`, and `region-double-clicked` events.
- Produces: `WaveformInteractionHandlers`, passed as the third argument to `WaveformAdapterFactory` and `createWaveformAdapter`.
- Produces Svelte props: `onannotationpreview(annotationId: string, previewing: boolean): void` and `onannotationactivate(annotationId: string): void` on both `WaveformView.svelte` and `TimelineWorkspace.svelte`.
- Preserves: `WaveformAdapter`'s six renderer methods, `AnnotationTable` behavior, canonical selection drag/resize, layer order, zoom anchoring, and renderer-only audio architecture.

- [ ] **Step 1: Write adapter interaction tests and upgrade the test double before production code**

Extend each fake region with an official-style `on` method and listener/disposer tracking:

```ts
interface RegionDouble {
  id: string;
  start: number;
  end: number;
  element: HTMLDivElement;
  options: Record<string, unknown>;
  setOptions: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emit(event: 'over' | 'leave', mouse?: MouseEvent): void;
}
```

Change all existing `createWaveformAdapter` test calls to provide a real handler object rather than a positional selection spy:

```ts
const handlers = {
  onSelectionChange: vi.fn(),
  onAnnotationPreview: vi.fn(),
  onAnnotationActivate: vi.fn()
};
const adapter = createWaveformAdapter(container, peaks, handlers, fixture.factory);
```

Add focused tests that prove:

```ts
adapter.setAnnotations([{ id: 'a', startMs: 100, endMs: 300 }]);
fixture.waveListeners.get('ready')?.();
const passive = fixture.createdRegions.find(({ element }) =>
  element.dataset.lightscribeRegion === 'annotation'
)!;

expect(passive.options).toMatchObject({ drag: false, resize: false });
expect(passive.element.style.pointerEvents).toBe('all');
expect(passive.element.style.cursor).toBe('pointer');

passive.emit('over');
expect(handlers.onAnnotationPreview).toHaveBeenLastCalledWith('a', true);
passive.emit('leave');
expect(handlers.onAnnotationPreview).toHaveBeenLastCalledWith('a', false);
```

Fire the plugin's `region-clicked` listener and require all three handlers to remain untouched. Fire `region-double-clicked` for the passive region and require only `onAnnotationActivate('a')`; fire it for the canonical and preview regions and require no activation. Simulate `over('a')`, then `over('b')`, then `leave('a')` and preserve both ID-specific intents so App can reject the stale leave. Remove `a`, replace annotation sets, and destroy the adapter; invoke captured old listeners afterward and require no callback. Require each per-region disposer and the plugin double-click disposer to run exactly once. Keep the existing assertions that managed programmatic events do not emit selection changes.

- [ ] **Step 2: Write component and App integration tests before production code**

In `WaveformView.test.ts`, provide `onannotationpreview` and `onannotationactivate` spies and require `createAdapter` to receive this exact handler object on initial creation and peak replacement:

```ts
expect(createAdapter).toHaveBeenCalledWith(expect.any(HTMLDivElement), initialPeaks, {
  onSelectionChange: onchange,
  onAnnotationPreview: onannotationpreview,
  onAnnotationActivate: onannotationactivate
});
```

In `TimelineWorkspace.test.ts`, capture the handler object passed into the mocked factory, invoke its preview and activation members, and assert the component's matching props receive the same values without changing layer order or Ctrl+wheel zoom.

In `App.test.ts`, make the mocked factory retain its latest `WaveformInteractionHandlers`. Extend the existing overlapping-annotation integration test to invoke:

```ts
waveformInteractions.onAnnotationPreview('second', true);
await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith('second'));

waveformInteractions.onAnnotationPreview('first', true);
waveformInteractions.onAnnotationPreview('second', false);
await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith('first'));

waveformInteractions.onAnnotationActivate('second');
expect(screen.getByLabelText('Start milliseconds')).toHaveValue(1_500);
expect(screen.getByLabelText('End milliseconds')).toHaveValue(2_500);
expect(screen.getByLabelText('Transcription')).toHaveValue('Second transcription');
expect(secondRow).toHaveAttribute('aria-current', 'true');
```

Capture loop calls, save calls, saved projects, active rows, and boundaries before preview; wait longer than the 300 ms recovery debounce and require them unchanged. Exercise a transition-busy interval in the existing deferred open/close test harness, invoke the retained preview/activation callbacks, and require both to be ignored.

- [ ] **Step 3: Write browser and documentation tests before production code**

Extend the complete Playwright story where two passive regions already exist:

```ts
const stateBeforeWaveformHover = await page.evaluate(() => {
  const testState = (globalThis as typeof globalThis & {
    __LIGHTSCRIBE_TEST__: {
      saveProjectCalls: number;
      savedProject: Project | null;
      nativeCalls: Array<{ command: string }>;
    };
  }).__LIGHTSCRIBE_TEST__;
  return {
    saveProjectCalls: testState.saveProjectCalls,
    project: structuredClone(testState.savedProject),
    nativeCalls: structuredClone(testState.nativeCalls)
  };
});
const boundariesBeforeWaveformHover = {
  start: await page.getByLabel('Start milliseconds').inputValue(),
  end: await page.getByLabel('End milliseconds').inputValue()
};
await passiveRegions.first().hover();
await expect(previewRegions).toHaveCount(1);
await page.waitForTimeout(400);
const stateAfterWaveformHover = await page.evaluate(() => {
  const testState = (globalThis as typeof globalThis & {
    __LIGHTSCRIBE_TEST__: {
      saveProjectCalls: number;
      savedProject: Project | null;
      nativeCalls: Array<{ command: string }>;
    };
  }).__LIGHTSCRIBE_TEST__;
  return {
    saveProjectCalls: testState.saveProjectCalls,
    project: structuredClone(testState.savedProject),
    nativeCalls: structuredClone(testState.nativeCalls)
  };
});
expect(stateAfterWaveformHover).toEqual(stateBeforeWaveformHover);
expect({
  start: await page.getByLabel('Start milliseconds').inputValue(),
  end: await page.getByLabel('End milliseconds').inputValue()
}).toEqual(boundariesBeforeWaveformHover);
expect(await annotations.locator('.annotation-row').evaluateAll((rows) =>
  rows.map((row) => row.getAttribute('aria-current'))
)).toEqual([null, null]);

await page.getByText('Ctrl + wheel to zoom').hover();
await expect(previewRegions).toHaveCount(0);
await passiveRegions.nth(1).dblclick();
await expect(page.getByLabel('Start milliseconds')).toHaveValue('1500');
await expect(page.getByLabel('End milliseconds')).toHaveValue('2500');
await expect(annotations.locator('.annotation-row').nth(1)).toHaveAttribute('aria-current', 'true');
```

Use this explicit state capture: compare `saveProjectCalls`, deep-cloned `savedProject`, `nativeCalls`, visible boundaries, and row `aria-current` values before and after hover. Do not assert only preview-region count.

After activation, require the active action order `Update annotation`, `Add annotation`, `Clear annotation`. Update the active annotation through Update, then click the secondary Add and require the same 1500/2500 loop range, no active row, blank transcription/notes, default metadata, and unchanged saved row count. Replace all old `Clear` locators with `Clear annotation` and require its visible text to be `X`.

Update `task15.configuration.test.ts` and README assertions to lock this exact documentation:

```ts
expect(readme).toContain('hovering a saved waveform region previews it');
expect(readme).toContain('double-clicking activates it');
expect(readme).toContain('[Waveform Region and Inspector QoL Design](docs/superpowers/specs/2026-07-22-waveform-region-inspector-qol-design.md)');
```

- [ ] **Step 4: Run the consolidated Task 2 RED once**

Run:

```powershell
bun run test -- src/lib/waveform/wavesurferAdapter.test.ts src/lib/components/WaveformView.test.ts src/lib/components/TimelineWorkspace.test.ts src/App.test.ts src/task15.configuration.test.ts
```

Expected: focused failures show the old adapter factory signature, passive `pointer-events: none`, absent interaction callbacks, missing App wiring, and outdated README contract. Do not run Playwright RED because its production build would be a second expensive pre-implementation gate; the unit/component RED proves the missing production behavior.

- [ ] **Step 5: Add typed adapter interactions and lifecycle cleanup**

Define the interface and change the factory signature:

```ts
export interface WaveformInteractionHandlers {
  onSelectionChange(selection: Selection): void;
  onAnnotationPreview(annotationId: string, previewing: boolean): void;
  onAnnotationActivate(annotationId: string): void;
}

export type WaveformAdapterFactory = (
  container: HTMLElement,
  peaks: PeakData,
  handlers: WaveformInteractionHandlers
) => WaveformAdapter;
```

Accept `handlers` in `createWaveformAdapter`, replace the old `onchange(...)` call with `handlers.onSelectionChange(...)`, and make passive elements interactive:

```ts
element.style.pointerEvents = 'all';
element.style.cursor = 'pointer';
```

Maintain `annotationInteractionStops = new Map<string, () => void>()`. On passive-region creation, subscribe through the typed region API:

```ts
const stopOver = next.on('over', () => {
  if (!destroyed) handlers.onAnnotationPreview(annotation.id, true);
});
const stopLeave = next.on('leave', () => {
  if (!destroyed) handlers.onAnnotationPreview(annotation.id, false);
});
annotationInteractionStops.set(annotation.id, () => {
  stopOver();
  stopLeave();
});
```

Before a passive region is removed, call and delete its stored disposer. Add one plugin listener:

```ts
const stopDoubleClicked = regions.on('region-double-clicked', (next, event) => {
  if (destroyed || syncing) return;
  const annotation = [...annotationRegions].find(([, candidate]) => candidate === next);
  if (!annotation) return;
  event.preventDefault();
  event.stopPropagation();
  handlers.onAnnotationActivate(annotation[0]);
});
```

Destroy order must set `destroyed`, dispose every passive interaction and the plugin listener, remove regions under `syncing`, clear maps, stop all prior plugin/wave listeners, disconnect the palette observer, and destroy WaveSurfer exactly once.

- [ ] **Step 6: Forward typed interactions through Svelte and coordinate them in App**

Add required props to `WaveformView.svelte` and `TimelineWorkspace.svelte`:

```ts
export let onannotationpreview: (annotationId: string, previewing: boolean) => void;
export let onannotationactivate: (annotationId: string) => void;
```

Create adapters with:

```ts
adapter = createAdapter(container, nextPeaks, {
  onSelectionChange: onchange,
  onAnnotationPreview: onannotationpreview,
  onAnnotationActivate: onannotationactivate
});
```

Forward both props from TimelineWorkspace to WaveformView. In `App.svelte`, add these coordinator functions:

```ts
function previewWaveformAnnotation(annotationId: string, previewing: boolean): void {
  if (transitionBusy) return;
  if (previewing) previewAnnotationId = annotationId;
  else if (previewAnnotationId === annotationId) previewAnnotationId = null;
}

function activateWaveformAnnotation(annotationId: string): void {
  if (!transitionBusy) projectStore.selectAnnotation(annotationId);
}
```

Pass them to `TimelineWorkspace` as `onannotationpreview={previewWaveformAnnotation}` and `onannotationactivate={activateWaveformAnnotation}`. Leave row `onpreview`, `onselect`, and `onremove` unchanged.

- [ ] **Step 7: Update the concise product contract**

Rewrite the relevant README sentences to say that saved ranges are faint interactive waveform annotations; hovering either a saved row or saved waveform region previews it without mutation; clicking a row or double-clicking a waveform region activates it; and inspector Add can begin a fresh draft at the current loop range while list deletion remains destructive. Link the 2026-07-22 design and state that it supersedes only passive-region interaction and inspector-action requirements from the 2026-07-21 QoL design.

- [ ] **Step 8: Run focused GREEN and the complete release gate immediately before commit**

Run, in this order:

```powershell
bun run test -- src/lib/waveform/wavesurferAdapter.test.ts src/lib/components/WaveformView.test.ts src/lib/components/TimelineWorkspace.test.ts src/App.test.ts src/task15.configuration.test.ts
bun run verify
bun run test:e2e
bun tauri build
git diff --check
```

Expected: focused tests pass; the complete frontend suite passes; Svelte reports 0 errors and 0 warnings; production fake exclusion passes; Rust formatting, strict all-target Clippy, unit tests, and integration tests pass; both Playwright stories pass; EXE, MSI, and NSIS artifacts are produced; and diff check exits 0. If a command fails, use systematic debugging, fix the root cause, and rerun this entire release gate before committing.

- [ ] **Step 9: Commit Task 2 and run no post-commit tests**

```powershell
git add -- src/lib/waveform/wavesurferAdapter.ts src/lib/waveform/wavesurferAdapter.test.ts src/lib/components/WaveformView.svelte src/lib/components/WaveformView.test.ts src/lib/components/TimelineWorkspace.svelte src/lib/components/TimelineWorkspace.test.ts src/App.svelte src/App.test.ts tests/e2e/lightscribe.spec.ts README.md src/task15.configuration.test.ts
git commit -m "feat: interact with saved waveform regions"
```

Record exact RED and GREEN results, complete verification counts, browser results, package artifact paths, diff result, commit SHA, and concerns in the task report. Run no tests after the commit.

---

## Completion and review

After each task commit, generate a review package from that task's base to its head and dispatch an independent spec-compliance and code-quality reviewer. Fix all Critical and Important findings through the same implementer, rerun only the covering pre-commit gate, commit the fix, and return it to the same reviewer.

After both task reviews are clean, generate one package from base `efd2814d6f87948ce61d3c18a670914a22d989a3` through the feature head and dispatch a fresh whole-branch review against both the 2026-07-21 and 2026-07-22 designs. If the final review finds issues, send the complete findings list to one fix implementer and repeat the final review. Keep the completed feature branch unmerged unless the user later selects another branch-finishing option.
