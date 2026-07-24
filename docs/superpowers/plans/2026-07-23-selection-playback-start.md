# Selection Playback Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every paused-to-playing action restart an active waveform selection from its beginning.

**Architecture:** `App.svelte` will own one shared playback-toggle path for both the toolbar and global Space shortcut. Starting playback snapshots `project.activeSelection`, awaits `AudioSession.seek(startMs)` when present, and only then calls `AudioSession.play()`; pausing continues to call `AudioSession.pause()` without seeking.

**Tech Stack:** Svelte 5, TypeScript, Vitest, Testing Library, Tauri 2, Bun

## Global Constraints

- Work directly on local `master` in `C:\Users\squnk\source\repos\wolf-paper\lightscribe`; the user explicitly authorized this and no worktree may be created.
- The active selection is `project.activeSelection`; passive saved regions and hover previews never affect playback.
- Toolbar Play and the global Space shortcut must use the same application-level behavior.
- If an active selection exists, await the native seek to `selection.startMs` before issuing Play.
- Without an active selection, Play starts from the existing native position without seeking.
- Pause never seeks or rewinds.
- Every paused-to-playing action with an active selection restarts from its beginning, regardless of Loop state.
- A failed seek prevents Play and reaches the existing persistent error display.
- Rust remains the authoritative playback engine and clock. Do not change native playback, polling cadence, loop ownership, project persistence, TSV behavior, or waveform selection.
- Preserve the committed 2 px palette-colored playhead behavior from `86fa7a8`; add the missing cursor-width regression assertion while touching the relevant frontend tests.
- Follow consolidated TDD timing: focused RED, minimal implementation, focused GREEN, full verification, and commit in one uninterrupted pre-commit window. Do not run tests after the implementation commit.

---

### Task 1: Restart playback from the active selection

**Files:**
- Modify: `src/App.svelte:650-695`
- Modify: `src/App.test.ts`
- Modify: `src/lib/waveform/wavesurferAdapter.test.ts:216-275`

**Interfaces:**
- Consumes: `projectStore` (`get(projectStore).project?.activeSelection`), reactive `playback.state`, `audioSession.seek(milliseconds): Promise<void>`, `audioSession.play(): Promise<void>`, `audioSession.pause(): Promise<void>`, and `reportPromise(request): Promise<void>`.
- Produces: one shared `togglePlay(): void` used by both `ClipToolbar.actions.togglePlay` and the global Space shortcut.

- [ ] **Step 1: Add the failing application tests**

Add focused `App.test.ts` coverage that creates an active selection through the real waveform interaction callback and records native command order:

```ts
it('restarts an active selection before toolbar playback and never seeks while pausing', async () => {
  const bridge = makeFakeBridge();
  const nativeOrder: string[] = [];
  bridge.audioSeek.mockImplementation(async (milliseconds) => {
    nativeOrder.push(`seek:${milliseconds}`);
    bridge.snapshot = { ...bridge.snapshot, positionMs: milliseconds };
  });
  bridge.audioPlay.mockImplementation(async () => {
    nativeOrder.push('play');
    bridge.snapshot = { ...bridge.snapshot, state: 'playing' };
  });
  bridge.audioPause.mockImplementation(async () => {
    nativeOrder.push('pause');
    bridge.snapshot = { ...bridge.snapshot, state: 'paused' };
  });
  renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });
  await openClip();
  waveformInteractions.latest?.onSelectionChange({ startMs: 250, endMs: 600 });
  await waitFor(() => expect(screen.getByLabelText('Start milliseconds')).toHaveValue(250));

  await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
  await waitFor(() => expect(nativeOrder).toEqual(['seek:250', 'play']));

  await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await waitFor(() => expect(nativeOrder).toEqual(['seek:250', 'play', 'pause']));

  await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
  await waitFor(() => expect(nativeOrder).toEqual([
    'seek:250', 'play', 'pause', 'seek:250', 'play'
  ]));
});
```

Add three narrow cases using the same existing helpers:

```ts
it('restarts an active selection before playback from the Space shortcut', async () => {
  const bridge = makeFakeBridge();
  const pendingSeek = deferred<void>();
  const nativeOrder: string[] = [];
  bridge.audioSeek.mockImplementation(async (milliseconds) => {
    nativeOrder.push(`seek:${milliseconds}`);
    await pendingSeek.promise;
    bridge.snapshot = { ...bridge.snapshot, positionMs: milliseconds };
  });
  bridge.audioPlay.mockImplementation(async () => {
    nativeOrder.push('play');
    bridge.snapshot = { ...bridge.snapshot, state: 'playing' };
  });
  renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });
  await openClip();
  waveformInteractions.latest?.onSelectionChange({ startMs: 300, endMs: 700 });
  await waitFor(() => expect(screen.getByLabelText('Start milliseconds')).toHaveValue(300));

  const space = new KeyboardEvent('keydown', {
    code: 'Space', key: ' ', bubbles: true, cancelable: true
  });
  window.dispatchEvent(space);

  await waitFor(() => expect(nativeOrder).toEqual(['seek:300']));
  expect(bridge.audioPlay).not.toHaveBeenCalled();
  expect(space.defaultPrevented).toBe(true);

  pendingSeek.resolve();
  await waitFor(() => expect(nativeOrder).toEqual(['seek:300', 'play']));
});

it('plays from the current native position when no selection is active', async () => {
  const bridge = makeFakeBridge();
  renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });
  await openClip();
  bridge.audioSeek.mockClear();
  bridge.audioPlay.mockClear();

  await fireEvent.click(screen.getByRole('button', { name: 'Play' }));

  await waitFor(() => expect(bridge.audioPlay).toHaveBeenCalledTimes(1));
  expect(bridge.audioSeek).not.toHaveBeenCalled();
});

it('does not play when seeking to the active selection fails', async () => {
  const bridge = makeFakeBridge();
  renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });
  await openClip();
  waveformInteractions.latest?.onSelectionChange({ startMs: 400, endMs: 800 });
  await waitFor(() => expect(screen.getByLabelText('Start milliseconds')).toHaveValue(400));
  bridge.audioSeek.mockRejectedValueOnce(new Error('seek failed'));
  bridge.audioPlay.mockClear();

  await fireEvent.click(screen.getByRole('button', { name: 'Play' }));

  expect(await screen.findByRole('alert', { name: 'Application error' }))
    .toHaveTextContent('seek failed');
  expect(bridge.audioPlay).not.toHaveBeenCalled();
});
```

The command-order assertions must wait for the asynchronous session refreshes and must clear any setup calls before measuring playback behavior.

- [ ] **Step 2: Add the playhead regression assertion**

In the existing WaveSurfer renderer-only test, assert the actual option that makes the cursor visible:

```ts
expect(options.cursorWidth).toBe(2);
```

Keep the existing `cursorColor` palette assertion and `renderProgress(0.275, false)` assertion. This test is characterization coverage for the already committed `86fa7a8` playhead fix; do not change its production behavior.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
bun run test -- src/App.test.ts src/lib/waveform/wavesurferAdapter.test.ts
```

Expected: the new active-selection toolbar and Space cases fail because current Play calls `audioSession.play()` without first seeking. The no-selection, pause, and cursor-width characterization assertions may already pass. Confirm the failures are behavioral assertions, not setup or timing errors.

- [ ] **Step 4: Implement one shared playback path**

Replace the current playback toggle with an async start helper plus the existing guarded toggle:

```ts
async function startPlayback(): Promise<void> {
  const selection = get(projectStore).project?.activeSelection;
  if (selection) await audioSession.seek(selection.startMs);
  await audioSession.play();
}

function togglePlay(): void {
  if (transitionBusy || closePromise) return;
  void reportPromise(
    playback.state === 'playing'
      ? audioSession.pause()
      : startPlayback()
  );
}
```

In `globalKeydown`, route Space through that same function:

```ts
if (event.code === 'Space') {
  event.preventDefault();
  togglePlay();
  return;
}
```

Do not change the remaining shortcut snapshot logic for I, O, L, or arrow seeking.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
bun run test -- src/App.test.ts src/lib/waveform/wavesurferAdapter.test.ts
```

Expected: both test files pass with all new ordering, error, no-selection, pause, repeated-start, Space, and playhead assertions green.

- [ ] **Step 6: Run the complete pre-commit gate**

Run in this order:

```powershell
bun run verify
bun run test:e2e
bun tauri build
git diff --check
```

Expected:

- Vitest, Svelte check, production frontend build, Rust formatting, strict Clippy, and Rust tests all pass.
- Playwright stories pass.
- The Windows EXE, MSI, and NSIS packages rebuild successfully.
- `git diff --check` exits 0.

If an exact running packaged Lightscribe process locks the release executable, identify its full executable path before requesting permission to close it gracefully; never force-close an unrelated process.

- [ ] **Step 7: Self-review and commit directly to master**

Review the diff against every Global Constraint, confirm only the three authorized source/test files changed, and commit:

```powershell
git add -- src/App.svelte src/App.test.ts src/lib/waveform/wavesurferAdapter.test.ts
git commit -m "fix: start playback from active selection"
```

Do not run tests after the commit. Write the required subagent report with RED, GREEN, full-gate, artifact, diff-check, commit, and concern details.
