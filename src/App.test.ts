import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import { createProject } from './lib/domain/project';
import type { PeakData } from './lib/bridge/native';
import { PALETTE_STORAGE_KEY } from './lib/theme/palette';
import { fakeIdentity, fakePeaks, makeFakeBridge, makeFakeLifecycle, nullPickers } from './test/fakeBridge';

const waveformSpies = vi.hoisted(() => ({
  setSelection: vi.fn(),
  setAnnotations: vi.fn(),
  setPreviewAnnotation: vi.fn(),
  setPlayhead: vi.fn(),
  setZoom: vi.fn(),
  destroy: vi.fn()
}));
const waveformInteractions = vi.hoisted(() => ({
  latest: null as null | {
    onSelectionChange(selection: { startMs: number; endMs: number }): void;
    onAnnotationPreview(annotationId: string, previewing: boolean): void;
    onAnnotationActivate(annotationId: string): void;
  }
}));

vi.mock('./lib/waveform/wavesurferAdapter', () => ({
  createWaveformAdapter: (_container: HTMLElement, _peaks: unknown, interactions: NonNullable<typeof waveformInteractions.latest>) => {
    waveformInteractions.latest = interactions;
    return waveformSpies;
  }
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function replaceSequentially(input: HTMLElement, value: string): Promise<void> {
  await fireEvent.input(input, { target: { value: '' } });
  let entered = '';
  for (const digit of value) {
    entered += digit;
    await fireEvent.input(input, { target: { value: entered } });
  }
}

function renderApp(overrides: Record<string, unknown> = {}) {
  const bridge = makeFakeBridge();
  const close = makeFakeLifecycle();
  const props = { bridge, pickers: nullPickers, lifecycle: close.lifecycle, ...overrides };
  const result = render(App, props);
  return { bridge: props.bridge as ReturnType<typeof makeFakeBridge>, close, ...result };
}

async function openClip() {
  await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
  await screen.findByLabelText('Audio waveform');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Settings' })).toBeEnabled());
}

describe('App', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    delete document.documentElement.dataset.palette;
    Object.values(waveformSpies).forEach((spy) => spy.mockClear());
    waveformInteractions.latest = null;
  });

  it('identifies the product and empty state without touching a live Tauri window', () => {
    renderApp();
    expect(screen.getByRole('heading', { name: 'Lightscribe' })).toBeInTheDocument();
    expect(screen.getByText('Open an MP3 or WAV file to begin.')).toBeInTheDocument();
  });

  it('mounts with the Ion Magenta fallback when the localStorage getter throws', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('storage denied'); });

    expect(() => renderApp()).not.toThrow();
    expect(screen.queryByRole('alert', { name: 'Application error' })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('radio', { name: /Ion Magenta/ })).toBeChecked();
  });

  it('opens and closes Settings, persists palette changes, and keeps project settings in the modal', async () => {
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    renderApp({ pickers: { ...nullPickers, audio: async () => 'clip.wav' } });

    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Speaker manager' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Acoustic tag manager' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Multiline export policy' })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('Open a project to manage labels.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('radio', { name: /Arctic Steel/ }));
    expect(storageWrite).toHaveBeenCalledWith(PALETTE_STORAGE_KEY, 'arctic-steel');
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('arctic-steel');
    expect(document.documentElement).toHaveAttribute('data-palette', 'arctic-steel');
    await fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();

    await openClip();
    expect(screen.queryByRole('region', { name: 'Speaker manager' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Acoustic tag manager' })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('region', { name: 'Speaker manager' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Acoustic tag manager' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Multiline export policy' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(screen.queryByRole('region', { name: 'Speaker manager' })).not.toBeInTheDocument();
  });

  it('previews overlapping saved annotations without mutation, activates on click, and clears removed previews', async () => {
    const identity = fakeIdentity('clip.wav', 10_000);
    const restored = createProject(identity);
    restored.annotations = [{
      ...restored.draft,
      id: 'first',
      startMs: 1_000,
      endMs: 2_000,
      transcription: 'First transcription',
      acousticTagIds: [restored.acousticTags[0].id],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    }, {
      ...restored.draft,
      id: 'second',
      startMs: 1_500,
      endMs: 2_500,
      transcription: 'Second transcription',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    }];
    restored.activeSelection = { startMs: 3_000, endMs: 4_000 };
    restored.activeAnnotationId = null;
    restored.draft = {
      ...restored.draft,
      startMs: 3_000,
      endMs: 4_000,
      transcription: ''
    };
    const bridge = makeFakeBridge({ identity, restored });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });

    await openClip();
    const workspace = screen.getByLabelText('Audio waveform').closest('.project-workspace');
    const timeline = screen.getByTestId('timeline-workspace');
    const lowerWorkspace = workspace?.querySelector('.lower-workspace');
    expect(workspace?.firstElementChild).toBe(timeline);
    expect(lowerWorkspace?.children[0]).toHaveClass('annotation-column');
    expect(lowerWorkspace?.children[1]).toHaveClass('annotation-dashboard');
    expect(lowerWorkspace?.querySelector('.annotation-column')?.children[0]).toHaveClass('active-text-editor');
    expect(lowerWorkspace?.querySelector('.annotation-column')?.children[1]).toHaveClass('annotation-table');
    expect(screen.getByRole('button', { name: 'Add annotation' })).toBeInTheDocument();
    expect(waveformSpies.setAnnotations).toHaveBeenCalledWith([
      { id: 'first', startMs: 1_000, endMs: 2_000 },
      { id: 'second', startMs: 1_500, endMs: 2_500 }
    ]);

    const firstRow = screen.getByRole('row', { name: 'Activate annotation First transcription' });
    const secondRow = screen.getByRole('row', { name: 'Activate annotation Second transcription' });
    const loopCallsBeforeHover = bridge.audioSetLoop.mock.calls.length;
    const saveCallsBeforeHover = bridge.saveProject.mock.calls.length;
    const savedProjectsBeforeHover = structuredClone(bridge.savedProjects);
    const boundariesBeforeHover = {
      start: (screen.getByLabelText('Start milliseconds') as HTMLInputElement).value,
      end: (screen.getByLabelText('End milliseconds') as HTMLInputElement).value
    };
    const activeRowsBeforeHover = [
      firstRow.getAttribute('aria-current'),
      secondRow.getAttribute('aria-current')
    ];
    const interactions = waveformInteractions.latest!;

    interactions.onAnnotationPreview('second', true);
    await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith('second'));
    interactions.onAnnotationPreview('first', true);
    interactions.onAnnotationPreview('second', false);
    await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith('first'));
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(screen.getByLabelText('Start milliseconds')).toHaveValue(Number(boundariesBeforeHover.start));
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(Number(boundariesBeforeHover.end));
    expect([firstRow.getAttribute('aria-current'), secondRow.getAttribute('aria-current')])
      .toEqual(activeRowsBeforeHover);
    expect(bridge.audioSetLoop).toHaveBeenCalledTimes(loopCallsBeforeHover);
    expect(bridge.saveProject).toHaveBeenCalledTimes(saveCallsBeforeHover);
    expect(bridge.savedProjects).toEqual(savedProjectsBeforeHover);
    interactions.onAnnotationPreview('first', false);

    await fireEvent.pointerEnter(secondRow);

    await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith('second'));
    expect(screen.getByLabelText('Start milliseconds')).toHaveValue(3_000);
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(4_000);
    expect(firstRow).not.toHaveAttribute('aria-current');
    expect(secondRow).not.toHaveAttribute('aria-current');
    expect(bridge.audioSetLoop).toHaveBeenCalledTimes(loopCallsBeforeHover);
    expect(bridge.saveProject).toHaveBeenCalledTimes(saveCallsBeforeHover);
    expect(bridge.savedProjects).toEqual(savedProjectsBeforeHover);

    await fireEvent.pointerLeave(secondRow, { relatedTarget: null });
    await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith(null));
    interactions.onAnnotationActivate('second');

    await waitFor(() => expect(screen.getByLabelText('Start milliseconds')).toHaveValue(1_500));
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(2_500);
    expect(screen.getByLabelText('Transcription')).toHaveValue('Second transcription');
    expect(screen.getByRole('button', { name: 'Update annotation' })).toBeInTheDocument();
    expect(secondRow).toHaveAttribute('aria-current', 'true');

    await fireEvent.pointerEnter(firstRow);
    await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith('first'));
    await fireEvent.click(screen.getByRole('button', { name: 'Remove annotation First transcription' }));
    await waitFor(() => expect(firstRow).not.toBeInTheDocument());
    await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith(null));
  });

  it('arbitrates retained table focus and waveform previews without changing editor state', async () => {
    const identity = fakeIdentity('clip.wav', 10_000);
    const restored = createProject(identity);
    restored.annotations = [{
      ...restored.draft,
      id: 'first',
      startMs: 1_000,
      endMs: 2_000,
      transcription: 'First transcription',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    }, {
      ...restored.draft,
      id: 'second',
      startMs: 1_500,
      endMs: 2_500,
      transcription: 'Second transcription',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    }];
    restored.activeSelection = { startMs: 3_000, endMs: 4_000 };
    restored.draft = { ...restored.draft, startMs: 3_000, endMs: 4_000 };
    const bridge = makeFakeBridge({ identity, restored });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });

    await openClip();
    const firstRow = screen.getByRole('row', { name: 'Activate annotation First transcription' });
    const secondRow = screen.getByRole('row', { name: 'Activate annotation Second transcription' });
    const interactions = waveformInteractions.latest!;
    const loopCallsBeforePreview = bridge.audioSetLoop.mock.calls.length;
    const saveCallsBeforePreview = bridge.saveProject.mock.calls.length;
    const savedProjectsBeforePreview = structuredClone(bridge.savedProjects);
    const activeRowsBeforePreview = [firstRow.getAttribute('aria-current'), secondRow.getAttribute('aria-current')];
    waveformSpies.setPreviewAnnotation.mockClear();

    await fireEvent.focusIn(firstRow);
    await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith('first'));
    interactions.onAnnotationPreview('second', true);
    await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith('second'));
    interactions.onAnnotationPreview('second', false);
    await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith('first'));

    const callsBeforeSameIdLeave = waveformSpies.setPreviewAnnotation.mock.calls.length;
    interactions.onAnnotationPreview('first', true);
    interactions.onAnnotationPreview('first', false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith('first');
    expect(waveformSpies.setPreviewAnnotation.mock.calls.slice(callsBeforeSameIdLeave))
      .not.toContainEqual([null]);

    await fireEvent.focusOut(firstRow, { relatedTarget: null });
    await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith(null));
    await fireEvent.focusIn(firstRow);
    await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith('first'));
    interactions.onAnnotationPreview('second', true);
    await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith('second'));
    await fireEvent.focusOut(firstRow, { relatedTarget: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith('second');
    interactions.onAnnotationPreview('second', false);
    await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith(null));

    const renderedTransitions = waveformSpies.setPreviewAnnotation.mock.calls
      .map(([annotationId]) => annotationId)
      .filter((annotationId, index, values) => index === 0 || annotationId !== values[index - 1]);
    if (renderedTransitions[0] === null) renderedTransitions.shift();
    expect(renderedTransitions).toEqual(['first', 'second', 'first', null, 'first', 'second', null]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(screen.getByLabelText('Start milliseconds')).toHaveValue(3_000);
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(4_000);
    expect([firstRow.getAttribute('aria-current'), secondRow.getAttribute('aria-current')])
      .toEqual(activeRowsBeforePreview);
    expect(bridge.audioSetLoop).toHaveBeenCalledTimes(loopCallsBeforePreview);
    expect(bridge.saveProject).toHaveBeenCalledTimes(saveCallsBeforePreview);
    expect(bridge.savedProjects).toEqual(savedProjectsBeforePreview);
  });

  it('completes open, select/loop, annotate/update, reopen, import, and export using real stores', async () => {
    const identity = fakeIdentity('C:\\audio\\clip.wav');
    const imported = {
      speakers: ['guest'], acousticTags: ['laugh'], annotations: [{
        startMs: 300, endMs: 400, eventType: 'speech' as const, transcription: 'imported',
        intelligibility: 'intelligible' as const, speaker: 'guest', overlap: 'none' as const,
        confidence: 'high' as const, acousticTags: ['laugh'], notes: ''
      }]
    };
    const bridge = makeFakeBridge({ identity, imported });
    bridge.loadProject.mockImplementation(async () => bridge.savedProjects.at(-1) ?? null);
    const close = makeFakeLifecycle();
    const audio = vi.fn(async () => 'C:\\audio\\clip.wav');
    render(App, {
      bridge, lifecycle: close.lifecycle,
      pickers: { audio, tsv: async () => 'rows.tsv', exportTsv: async () => 'clip.tsv' },
      id: (() => { let serial = 0; return () => `integration-${++serial}`; })(),
      now: () => '2026-01-01T00:00:00Z'
    });

    await openClip();
    await fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const multilinePolicy = screen.getByRole('combobox', { name: 'Multiline export policy' });
    expect(multilinePolicy).toHaveValue('escape');
    expect(multilinePolicy).toHaveTextContent('Escape line breaks as \\n');
    expect(multilinePolicy).toHaveTextContent('Replace line breaks with spaces');
    expect(multilinePolicy).toHaveTextContent('Preserve line breaks in quoted fields');
    await fireEvent.change(multilinePolicy, { target: { value: 'space' } });
    await waitFor(() => expect(bridge.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      exportSettings: { multilinePolicy: 'space' }
    })));
    await fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(screen.getByTestId('timeline-content').children).toHaveLength(4);
    await fireEvent.input(screen.getByLabelText('Start milliseconds'), { target: { value: '100' } });
    await fireEvent.input(screen.getByLabelText('End milliseconds'), { target: { value: '250' } });
    await fireEvent.change(screen.getByLabelText('End milliseconds'));
    await fireEvent.click(screen.getByRole('button', { name: 'Loop off' }));
    await waitFor(() => expect(bridge.audioSetLoop).toHaveBeenCalledWith({ startMs: 100, endMs: 250 }));
    await fireEvent.input(screen.getByLabelText('Transcription'), { target: { value: 'うん' } });
    await fireEvent.keyDown(screen.getByLabelText('Transcription'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByLabelText('Saved annotations')).toHaveTextContent('うん'));
    await fireEvent.input(screen.getByLabelText('Transcription'), { target: { value: 'うん!' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Update annotation' }));
    await waitFor(() => expect(screen.getByLabelText('Saved annotations')).toHaveTextContent('うん!'));

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    await waitFor(() => expect(audio).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(bridge.audioOpen).toHaveBeenCalledTimes(2));
    await fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('combobox', { name: 'Multiline export policy' })).toHaveValue('space');
    await fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import TSV' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Import TSV' }));
    expect(await screen.findByText('imported')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Export TSV' }));
    await waitFor(() => expect(bridge.writeTsv).toHaveBeenCalledWith('clip.tsv', expect.objectContaining({
      exportSettings: { multilinePolicy: 'space' },
      annotations: expect.arrayContaining([expect.objectContaining({ transcription: 'うん!' }), expect.objectContaining({ transcription: 'imported' })])
    })));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Operation status' })).toHaveTextContent('Exported 2 annotations'));
  });

  it('clears an enabled native loop when the inspector clears its canonical selection', async () => {
    const bridge = makeFakeBridge({ identity: fakeIdentity('clip.wav', 10_000) });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });
    await openClip();

    await fireEvent.input(screen.getByLabelText('Start milliseconds'), { target: { value: '100' } });
    await fireEvent.input(screen.getByLabelText('End milliseconds'), { target: { value: '1000' } });
    await fireEvent.change(screen.getByLabelText('End milliseconds'));
    await fireEvent.click(screen.getByRole('button', { name: 'Loop off' }));
    await waitFor(() => expect(bridge.audioSetLoop).toHaveBeenCalledWith({ startMs: 100, endMs: 1_000 }));

    await fireEvent.click(screen.getByRole('button', { name: 'Clear annotation' }));

    await waitFor(() => expect(bridge.audioClearLoop).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Loop off' })).toBeDisabled();
    expect(screen.getByLabelText('Start milliseconds')).toHaveValue(0);
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(0);
    expect(waveformSpies.setSelection).toHaveBeenLastCalledWith(null);
  });

  it('preserves a mismatched native loop when clearing the App-owned selection', async () => {
    const bridge = makeFakeBridge({ identity: fakeIdentity('clip.wav', 10_000) });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });
    await openClip();

    await fireEvent.input(screen.getByLabelText('Start milliseconds'), { target: { value: '100' } });
    await fireEvent.input(screen.getByLabelText('End milliseconds'), { target: { value: '1000' } });
    await fireEvent.change(screen.getByLabelText('End milliseconds'));
    await fireEvent.click(screen.getByRole('button', { name: 'Loop off' }));
    await waitFor(() => expect(bridge.audioSetLoop).toHaveBeenCalledWith({ startMs: 100, endMs: 1_000 }));

    const snapshotCallsBeforeReplacement = bridge.audioSnapshot.mock.calls.length;
    bridge.snapshot = { ...bridge.snapshot, loopRange: { startMs: 200, endMs: 300 } };
    await waitFor(() => expect(bridge.audioSnapshot.mock.calls.length)
      .toBeGreaterThan(snapshotCallsBeforeReplacement));
    bridge.audioClearLoop.mockClear();
    const snapshotCallsBeforeClear = bridge.audioSnapshot.mock.calls.length;

    await fireEvent.click(screen.getByRole('button', { name: 'Clear annotation' }));

    await waitFor(() => expect(bridge.audioSnapshot.mock.calls.length).toBeGreaterThan(snapshotCallsBeforeClear));
    expect(bridge.audioClearLoop).not.toHaveBeenCalled();
    expect(bridge.snapshot.loopRange).toEqual({ startMs: 200, endMs: 300 });
    expect(screen.getByLabelText('Start milliseconds')).toHaveValue(0);
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(0);
    expect(waveformSpies.setSelection).toHaveBeenLastCalledWith(null);
  });

  it('clears a pending App-owned loop when selection clears before native enable completes', async () => {
    const bridge = makeFakeBridge({ identity: fakeIdentity('clip.wav', 10_000) });
    const pendingEnable = deferred<void>();
    const enableApplied = deferred<void>();
    bridge.audioSetLoop.mockImplementationOnce(async (selection) => {
      await pendingEnable.promise;
      bridge.snapshot = { ...bridge.snapshot, loopRange: selection };
      enableApplied.resolve();
    });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });
    await openClip();

    await fireEvent.input(screen.getByLabelText('Start milliseconds'), { target: { value: '100' } });
    await fireEvent.input(screen.getByLabelText('End milliseconds'), { target: { value: '1000' } });
    await fireEvent.change(screen.getByLabelText('End milliseconds'));
    await fireEvent.click(screen.getByRole('button', { name: 'Loop off' }));
    await waitFor(() => expect(bridge.audioSetLoop).toHaveBeenCalledWith({ startMs: 100, endMs: 1_000 }));
    expect(bridge.snapshot.loopRange).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Clear annotation' }));
    const snapshotCallsBeforeResolve = bridge.audioSnapshot.mock.calls.length;
    pendingEnable.resolve();
    await enableApplied.promise;
    await waitFor(() => expect(bridge.audioSnapshot.mock.calls.length).toBeGreaterThan(snapshotCallsBeforeResolve));

    expect(bridge.audioClearLoop).toHaveBeenCalledOnce();
    expect(bridge.snapshot.loopRange).toBeNull();
    expect(screen.getByRole('button', { name: 'Loop off' })).toBeDisabled();
    expect(screen.getByLabelText('Start milliseconds')).toHaveValue(0);
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(0);
    expect(waveformSpies.setSelection).toHaveBeenLastCalledWith(null);
  });

  it('restores a mismatched native loop when selection clears during a pending App-owned enable', async () => {
    const bridge = makeFakeBridge({ identity: fakeIdentity('clip.wav', 10_000) });
    const pendingEnable = deferred<void>();
    const enableApplied = deferred<void>();
    const appSelection = { startMs: 100, endMs: 1_000 };
    const externalLoop = { startMs: 200, endMs: 300 };
    bridge.audioSetLoop.mockImplementationOnce(async (selection) => {
      await pendingEnable.promise;
      bridge.snapshot = { ...bridge.snapshot, loopRange: selection };
      enableApplied.resolve();
    });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });
    await openClip();

    await fireEvent.input(screen.getByLabelText('Start milliseconds'), { target: { value: '100' } });
    await fireEvent.input(screen.getByLabelText('End milliseconds'), { target: { value: '1000' } });
    await fireEvent.change(screen.getByLabelText('End milliseconds'));
    await fireEvent.click(screen.getByRole('button', { name: 'Loop off' }));
    await waitFor(() => expect(bridge.audioSetLoop).toHaveBeenCalledWith(appSelection));

    bridge.snapshot = { ...bridge.snapshot, loopRange: externalLoop };
    await waitFor(() => expect(screen.getByRole('button', { name: 'Loop on' })).toBeInTheDocument());
    await fireEvent.click(screen.getByRole('button', { name: 'Clear annotation' }));
    pendingEnable.resolve();
    await enableApplied.promise;

    await waitFor(() => expect(bridge.audioSetLoop).toHaveBeenCalledTimes(2));
    expect(bridge.audioSetLoop.mock.calls.map(([selection]) => selection)).toEqual([appSelection, externalLoop]);
    expect(bridge.audioClearLoop).not.toHaveBeenCalled();
    expect(bridge.snapshot.loopRange).toEqual(externalLoop);
    expect(screen.getByRole('button', { name: 'Loop on' })).toBeEnabled();
    expect(screen.getByLabelText('Start milliseconds')).toHaveValue(0);
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(0);
    expect(waveformSpies.setSelection).toHaveBeenLastCalledWith(null);
  });

  it('reconciles a loop queued during final refresh before it can become a ghost loop', async () => {
    const bridge = makeFakeBridge({ identity: fakeIdentity('clip.wav', 10_000) });
    const loopB = { startMs: 100, endMs: 1_000 };
    const loopC = { startMs: 200, endMs: 1_200 };
    const loopD = { startMs: 300, endMs: 1_300 };
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });
    await openClip();
    const interactions = waveformInteractions.latest!;

    interactions.onSelectionChange(loopB);
    await waitFor(() => expect(screen.getByLabelText('Start milliseconds')).toHaveValue(loopB.startMs));
    await fireEvent.click(screen.getByRole('button', { name: 'Loop off' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Loop on' })).toBeInTheDocument());
    expect(bridge.snapshot.loopRange).toEqual(loopB);
    await Promise.resolve();
    await Promise.resolve();

    const refreshC = deferred<typeof bridge.snapshot>();
    const refreshCStarted = deferred<void>();
    const setCApplied = deferred<void>();
    const setD = deferred<void>();
    const setDStarted = deferred<void>();
    let holdRefreshC = false;
    let cCommandCount = 0;
    bridge.audioSnapshot.mockImplementation(async () => {
      if (holdRefreshC) {
        refreshCStarted.resolve();
        return refreshC.promise;
      }
      return bridge.snapshot;
    });
    bridge.audioSetLoop.mockImplementation(async (selection) => {
      if (selection.startMs === loopC.startMs && selection.endMs === loopC.endMs) {
        cCommandCount += 1;
        bridge.snapshot = { ...bridge.snapshot, loopRange: selection };
        if (cCommandCount === 1) {
          holdRefreshC = true;
          setCApplied.resolve();
        }
        return;
      }
      if (selection.startMs === loopD.startMs && selection.endMs === loopD.endMs) {
        setDStarted.resolve();
        await setD.promise;
        bridge.snapshot = { ...bridge.snapshot, loopRange: selection };
        return;
      }
      bridge.snapshot = { ...bridge.snapshot, loopRange: selection };
    });

    interactions.onSelectionChange(loopC);
    await setCApplied.promise;
    await refreshCStarted.promise;
    expect(bridge.snapshot.loopRange).toEqual(loopC);
    interactions.onSelectionChange(loopD);
    await waitFor(() => expect(screen.getByLabelText('Start milliseconds')).toHaveValue(loopD.startMs));
    await Promise.resolve();

    holdRefreshC = false;
    refreshC.resolve({ ...bridge.snapshot, loopRange: loopC });
    await setDStarted.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.snapshot.loopRange).toEqual(loopC);

    await fireEvent.click(screen.getByRole('button', { name: 'Clear annotation' }));
    await waitFor(() => expect(screen.getByLabelText('Start milliseconds')).toHaveValue(0));
    await waitFor(() => expect(waveformSpies.setSelection).toHaveBeenLastCalledWith(null));
    setD.resolve();

    await waitFor(() => expect(bridge.audioSetLoop).toHaveBeenCalledTimes(4));
    expect(bridge.audioSetLoop.mock.calls.map(([selection]) => selection))
      .toEqual([loopB, loopC, loopD, loopC]);
    expect(bridge.audioClearLoop).not.toHaveBeenCalled();
    expect(bridge.snapshot.loopRange).toEqual(loopC);
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(0);
    expect(screen.getByRole('button', { name: 'Loop on' })).toBeEnabled();
  });

  it('holds empty and invalid boundary edits locally before realigning waveform, native loop, and export', async () => {
    const identity = fakeIdentity('clip.wav', 10_000);
    const bridge = makeFakeBridge({ identity });
    renderApp({
      bridge,
      pickers: { ...nullPickers, audio: async () => 'clip.wav', exportTsv: async () => 'clip.tsv' },
      id: () => 'numeric-event'
    });
    await openClip();

    await fireEvent.input(screen.getByLabelText('End milliseconds'), { target: { value: '1000' } });
    await fireEvent.input(screen.getByLabelText('Start milliseconds'), { target: { value: '100' } });
    await fireEvent.change(screen.getByLabelText('Start milliseconds'));
    await fireEvent.click(screen.getByRole('button', { name: 'Loop off' }));
    await waitFor(() => expect(bridge.audioSetLoop).toHaveBeenCalledWith({ startMs: 100, endMs: 1_000 }));
    bridge.audioSetLoop.mockClear();
    waveformSpies.setSelection.mockClear();

    const start = screen.getByLabelText('Start milliseconds');
    const end = screen.getByLabelText('End milliseconds');
    await replaceSequentially(start, '3000');
    expect(start).toHaveValue(3000);
    await Promise.resolve();
    expect(bridge.audioSetLoop).not.toHaveBeenCalled();
    expect(waveformSpies.setSelection.mock.calls.every(([selection]) => (
      selection.startMs === 100 && selection.endMs === 1_000
    ))).toBe(true);
    await fireEvent.change(start);
    expect(screen.getByRole('alert')).toHaveTextContent(/valid whole-millisecond range/i);
    expect(bridge.audioSetLoop).not.toHaveBeenCalled();

    await replaceSequentially(end, '4000');
    expect(end).toHaveValue(4000);
    await Promise.resolve();
    expect(bridge.audioSetLoop).not.toHaveBeenCalled();
    expect(waveformSpies.setSelection.mock.calls.every(([selection]) => (
      selection.startMs === 100 && selection.endMs === 1_000
    ))).toBe(true);

    await fireEvent.change(end);
    await waitFor(() => expect(waveformSpies.setSelection).toHaveBeenCalledWith({ startMs: 3_000, endMs: 4_000 }));
    await waitFor(() => expect(bridge.audioSetLoop).toHaveBeenCalledWith({ startMs: 3_000, endMs: 4_000 }));
    await fireEvent.input(screen.getByLabelText('Transcription'), { target: { value: 'numeric range' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add annotation' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update annotation' })).toBeInTheDocument());

    await fireEvent.click(screen.getByRole('button', { name: 'Export TSV' }));
    await waitFor(() => expect(bridge.writeTsv).toHaveBeenCalledWith('clip.tsv', expect.objectContaining({
      activeAnnotationId: 'numeric-event',
      activeSelection: { startMs: 3_000, endMs: 4_000 },
      draft: expect.objectContaining({ startMs: 3_000, endMs: 4_000 }),
      annotations: [expect.objectContaining({ id: 'numeric-event', startMs: 3_000, endMs: 4_000 })]
    })));
  });

  it('validates pending raw boundaries before transcription Enter can commit or persist', async () => {
    const identity = fakeIdentity('clip.wav', 10_000);
    const bridge = makeFakeBridge({ identity });
    renderApp({
      bridge,
      pickers: { ...nullPickers, audio: async () => 'clip.wav' },
      id: () => 'coordinated-event'
    });
    await openClip();

    const start = screen.getByLabelText('Start milliseconds');
    const end = screen.getByLabelText('End milliseconds');
    await fireEvent.input(end, { target: { value: '1000' } });
    await fireEvent.input(start, { target: { value: '100' } });
    await fireEvent.change(start);
    await waitFor(() => expect(waveformSpies.setSelection).toHaveBeenCalledWith({ startMs: 100, endMs: 1_000 }));

    await replaceSequentially(start, '3000');
    await fireEvent.change(start);
    expect(screen.getByRole('alert')).toHaveTextContent(/valid whole-millisecond range/i);
    const transcription = screen.getByRole('textbox', { name: 'Transcription' });
    await fireEvent.input(transcription, { target: { value: 'must wait for valid boundaries' } });
    bridge.saveProject.mockClear();

    await fireEvent.keyDown(transcription, { key: 'Enter' });
    await Promise.resolve();
    expect(screen.getByRole('button', { name: 'Add annotation' })).toBeInTheDocument();
    expect(screen.getByLabelText('Saved annotations').querySelectorAll('.annotation-row')).toHaveLength(0);
    expect(bridge.saveProject).not.toHaveBeenCalled();
    expect(start).toHaveValue(3000);
    expect(end).toHaveValue(1000);
    expect(screen.getByRole('alert')).toHaveTextContent(/valid whole-millisecond range/i);

    await replaceSequentially(end, '4000');
    await fireEvent.keyDown(transcription, { key: 'Enter' });
    await waitFor(() => expect(screen.getByLabelText('Saved annotations')).toHaveTextContent('must wait for valid boundaries'));
    await waitFor(() => expect(bridge.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      activeAnnotationId: 'coordinated-event',
      activeSelection: { startMs: 3_000, endMs: 4_000 },
      annotations: [expect.objectContaining({
        id: 'coordinated-event', startMs: 3_000, endMs: 4_000,
        transcription: 'must wait for valid boundaries'
      })]
    })));
    expect(screen.getByRole('button', { name: 'Update annotation' })).toBeInTheDocument();
  });

  it('normalizes a stale recovered selection to the newer valid editor boundaries on reopen', async () => {
    const identity = fakeIdentity('clip.wav', 10_000);
    const restored = createProject(identity);
    const annotation = {
      ...restored.draft,
      id: 'recovered-event',
      startMs: 100,
      endMs: 200,
      transcription: 'committed text',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    };
    restored.annotations = [annotation];
    restored.activeAnnotationId = annotation.id;
    restored.activeSelection = { startMs: 9_000, endMs: 12_000 };
    restored.draft = { ...annotation, startMs: 300, endMs: 400 };
    const bridge = makeFakeBridge({ identity, restored });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });

    await openClip();

    expect(screen.getByLabelText('Start milliseconds')).toHaveValue(300);
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(400);
    expect(screen.getByRole('button', { name: 'Update annotation' })).toBeInTheDocument();
    await waitFor(() => expect(waveformSpies.setSelection).toHaveBeenCalledWith({ startMs: 300, endMs: 400 }));
  });

  it('reopens a safe in-progress recovered draft before its transcription is complete', async () => {
    const identity = fakeIdentity('clip.wav', 10_000);
    const restored = createProject(identity);
    restored.activeSelection = { startMs: 100, endMs: 200 };
    restored.draft = { ...restored.draft, startMs: 300, endMs: 400, transcription: '' };
    const bridge = makeFakeBridge({ identity, restored });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });

    await openClip();

    expect(screen.queryByRole('alert', { name: 'Application error' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Start milliseconds')).toHaveValue(300);
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(400);
    expect(screen.getByRole('button', { name: 'Add annotation' })).toBeInTheDocument();
    await waitFor(() => expect(waveformSpies.setSelection).toHaveBeenCalledWith({ startMs: 300, endMs: 400 }));
  });

  it('normalizes legacy recovered intelligibility before subsequent export', async () => {
    const identity = fakeIdentity('clip.wav', 10_000);
    const restored = createProject(identity);
    const legacyIntelligibility = 'intelligible' as typeof restored.draft.intelligibility;
    restored.draft = {
      ...restored.draft,
      startMs: 100,
      endMs: 200,
      transcription: 'legacy draft',
      intelligibility: legacyIntelligibility
    };
    restored.annotations = [{
      ...restored.draft,
      id: 'legacy-event',
      transcription: 'legacy annotation',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    }];
    const bridge = makeFakeBridge({ identity, restored });
    renderApp({
      bridge,
      pickers: { ...nullPickers, audio: async () => 'clip.wav', exportTsv: async () => 'clip.tsv' }
    });

    await openClip();
    expect(screen.getByLabelText('Intelligibility')).toHaveValue('highly_intelligible');
    await fireEvent.click(screen.getByRole('button', { name: 'Export TSV' }));

    await waitFor(() => expect(bridge.writeTsv).toHaveBeenCalledWith('clip.tsv', expect.objectContaining({
      schemaVersion: 1,
      draft: expect.objectContaining({ intelligibility: 'highly_intelligible' }),
      annotations: [expect.objectContaining({ intelligibility: 'highly_intelligible' })]
    })));
  });

  it.each([
    ['not finite', Number.NaN, 400],
    ['fractional', 300.5, 400],
    ['past duration', 300, 10_001],
    ['non-increasing', 400, 300]
  ])('rejects %s recovered draft boundaries', async (_case, startMs, endMs) => {
    const identity = fakeIdentity('clip.wav', 10_000);
    const restored = createProject(identity);
    restored.activeSelection = { startMs: 100, endMs: 200 };
    restored.draft = { ...restored.draft, startMs, endMs };
    const bridge = makeFakeBridge({ identity, restored });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));

    expect(await screen.findByRole('alert', { name: 'Application error' })).toHaveTextContent(/recovered draft does not fit/i);
    expect(bridge.analyzeAudio).not.toHaveBeenCalled();
    expect(bridge.audioOpen).not.toHaveBeenCalled();
  });

  it.each([
    ['duplicate annotation IDs', (project: ReturnType<typeof createProject>) => {
      const annotation = {
        ...project.draft, id: 'duplicate', startMs: 100, endMs: 200, transcription: 'first',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z'
      };
      project.annotations = [annotation, { ...annotation, startMs: 300, endMs: 400, transcription: 'second' }];
      project.activeAnnotationId = 'duplicate';
    }],
    ['duplicate speaker IDs', (project: ReturnType<typeof createProject>) => {
      project.speakers[1].id = project.speakers[0].id;
    }],
    ['duplicate acoustic tag IDs', (project: ReturnType<typeof createProject>) => {
      project.acousticTags[1].id = project.acousticTags[0].id;
    }],
    ['an ID shared by speaker and acoustic tag definitions', (project: ReturnType<typeof createProject>) => {
      project.acousticTags[0].id = project.speakers[0].id;
      project.draft.acousticTagIds = [project.acousticTags[0].id];
    }]
  ] as const)('rejects recovered projects with %s', async (_case, corrupt) => {
    const identity = fakeIdentity('clip.wav', 10_000);
    const restored = createProject(identity);
    corrupt(restored);
    const bridge = makeFakeBridge({ identity, restored });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));

    expect(await screen.findByRole('alert', { name: 'Application error' })).toHaveTextContent(/unique nonempty project ID/i);
    expect(bridge.analyzeAudio).not.toHaveBeenCalled();
    expect(bridge.audioOpen).not.toHaveBeenCalled();
  });

  it.each([
    ['duplicate speaker label', 'speakers', 1, 'speaker_1'],
    ['blank speaker label', 'speakers', 0, '   '],
    ['reserved speaker label', 'speakers', 0, ' none '],
    ['tabbed speaker label', 'speakers', 0, 'guest\tname'],
    ['duplicate acoustic tag label', 'acousticTags', 1, 'quiet_dialogue'],
    ['blank acoustic tag label', 'acousticTags', 0, '   '],
    ['reserved acoustic tag label', 'acousticTags', 0, 'none'],
    ['tabbed acoustic tag label', 'acousticTags', 0, 'room\ttone'],
    ['semicolon acoustic tag label', 'acousticTags', 0, 'music;effects']
  ] as const)('rejects a recovered project with a %s', async (_case, kind, index, label) => {
    const identity = fakeIdentity('clip.wav', 10_000);
    const restored = createProject(identity);
    restored[kind][index].label = label;
    const bridge = makeFakeBridge({ identity, restored });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));

    expect(await screen.findByRole('alert', { name: 'Application error' })).toHaveTextContent(/recovered (speaker|acoustic tag) labels are invalid/i);
    expect(bridge.analyzeAudio).not.toHaveBeenCalled();
    expect(bridge.audioOpen).not.toHaveBeenCalled();
  });

  it.each([
    ['missing speaker reference', (project: ReturnType<typeof createProject>) => {
      project.draft.speakerId = 'missing-speaker';
    }],
    ['missing acoustic tag reference', (project: ReturnType<typeof createProject>) => {
      project.draft.acousticTagIds = ['missing-tag'];
    }],
    ['missing active annotation', (project: ReturnType<typeof createProject>) => {
      project.activeAnnotationId = 'missing-annotation';
    }]
  ] as const)('rejects a recovered project with a %s', async (_case, corrupt) => {
    const identity = fakeIdentity('clip.wav', 10_000);
    const restored = createProject(identity);
    corrupt(restored);
    const bridge = makeFakeBridge({ identity, restored });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));

    expect(await screen.findByRole('alert', { name: 'Application error' })).toHaveTextContent(/recovered (draft|active annotation)/i);
    expect(bridge.analyzeAudio).not.toHaveBeenCalled();
    expect(bridge.audioOpen).not.toHaveBeenCalled();
  });

  it('waits for an immediate multiline policy save before exporting the authoritative project', async () => {
    const policySave = deferred<void>();
    const bridge = makeFakeBridge();
    bridge.saveProject.mockImplementationOnce(() => policySave.promise).mockResolvedValue(undefined);
    renderApp({
      bridge,
      pickers: { ...nullPickers, audio: async () => 'clip.wav', exportTsv: async () => 'clip.tsv' }
    });
    await openClip();

    await fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const selector = screen.getByRole('combobox', { name: 'Multiline export policy' }) as HTMLSelectElement;
    const exportButton = screen.getByRole('button', { name: 'Export TSV' });
    selector.value = 'space';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
    await fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    exportButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(bridge.saveProject).toHaveBeenCalledTimes(1);
    expect(bridge.writeTsv).not.toHaveBeenCalled();
    policySave.resolve();

    await waitFor(() => expect(bridge.writeTsv).toHaveBeenCalledWith('clip.tsv', expect.objectContaining({
      exportSettings: { multilinePolicy: 'space' }
    })));
  });

  it('waits for an immediate multiline policy save before importing with the authoritative policy', async () => {
    const policySave = deferred<void>();
    const bridge = makeFakeBridge();
    bridge.saveProject.mockImplementationOnce(() => policySave.promise).mockResolvedValue(undefined);
    renderApp({
      bridge,
      pickers: { ...nullPickers, audio: async () => 'clip.wav', tsv: async () => 'rows.tsv' }
    });
    await openClip();

    await fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const selector = screen.getByRole('combobox', { name: 'Multiline export policy' }) as HTMLSelectElement;
    const importButton = screen.getByRole('button', { name: 'Import TSV' });
    selector.value = 'quoted';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
    await fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    importButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(bridge.saveProject).toHaveBeenCalledTimes(1);
    expect(bridge.readTsv).not.toHaveBeenCalled();
    policySave.resolve();

    await waitFor(() => expect(bridge.readTsv).toHaveBeenCalledWith('rows.tsv', 'quoted'));
  });

  it('preserves the old project, waveform, and native clip when preparing a replacement fails', async () => {
    const firstIdentity = fakeIdentity('old.wav');
    const bridge = makeFakeBridge({ identity: firstIdentity });
    bridge.inspectAudio.mockImplementation(async (path) => fakeIdentity(path));
    bridge.analyzeAudio.mockImplementation(async (path) => {
      if (path === 'bad.wav') throw new Error('cannot decode replacement');
      return fakePeaks();
    });
    const paths = ['old.wav', 'bad.wav'];
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => paths.shift() ?? null } });

    await openClip();
    await fireEvent.input(screen.getByLabelText('Notes'), { target: { value: 'keep this draft' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('cannot decode replacement');
    expect(screen.getByText('old.wav')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toHaveValue('keep this draft');
    expect(screen.getByLabelText('Audio waveform')).toBeInTheDocument();
    expect(bridge.audioOpen).toHaveBeenCalledTimes(1);
  });

  it('aborts replacement before native open when the old draft cannot be flushed', async () => {
    const bridge = makeFakeBridge({ identity: fakeIdentity('old.wav') });
    bridge.inspectAudio.mockImplementation(async (path) => fakeIdentity(path));
    const paths = ['old.wav', 'new.wav'];
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => paths.shift() ?? null } });
    await openClip();
    await fireEvent.input(screen.getByLabelText('Notes'), { target: { value: 'unsaved old draft' } });
    bridge.saveProject.mockRejectedValueOnce(new Error('recovery disk is full'));

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));

    expect(await screen.findByRole('alert', { name: 'Application error' })).toHaveTextContent('recovery disk is full');
    expect(screen.getByText('old.wav')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toHaveValue('unsaved old draft');
    expect(screen.getByRole('status', { name: 'Operation status' })).toHaveTextContent('Opened old.wav');
    expect(bridge.audioOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps the prior project and status when an imported project cannot be saved', async () => {
    const bridge = makeFakeBridge({ imported: {
      speakers: ['guest'], acousticTags: [], annotations: [{
        startMs: 10, endMs: 20, eventType: 'speech', transcription: 'must not publish',
        intelligibility: 'intelligible', speaker: 'guest', overlap: 'none', confidence: 'high',
        acousticTags: [], notes: ''
      }]
    } });
    renderApp({
      bridge,
      pickers: { audio: async () => 'clip.wav', tsv: async () => 'rows.tsv', exportTsv: async () => null }
    });
    await openClip();
    bridge.saveProject.mockRejectedValueOnce(new Error('import destination is read-only'));

    await fireEvent.click(screen.getByRole('button', { name: 'Import TSV' }));

    expect(await screen.findByRole('alert', { name: 'Application error' })).toHaveTextContent('import destination is read-only');
    expect(screen.queryByText('must not publish')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Operation status' })).toHaveTextContent('Opened clip.wav');
  });

  it('drains a committed import before native replacement and lets the new project win', async () => {
    const mutationSave = deferred<void>();
    const bridge = makeFakeBridge({ imported: {
      speakers: ['guest'], acousticTags: [], annotations: [{
        startMs: 10, endMs: 20, eventType: 'speech', transcription: 'committed old import',
        intelligibility: 'intelligible', speaker: 'guest', overlap: 'none', confidence: 'high',
        acousticTags: [], notes: ''
      }]
    } });
    bridge.inspectAudio.mockImplementation(async (path) => fakeIdentity(path));
    bridge.saveProject.mockImplementationOnce(() => mutationSave.promise).mockResolvedValue(undefined);
    const paths = ['old.wav', 'new.wav'];
    renderApp({
      bridge,
      pickers: { audio: async () => paths.shift() ?? null, tsv: async () => 'rows.tsv', exportTsv: async () => null }
    });
    await openClip();

    await fireEvent.click(screen.getByRole('button', { name: 'Import TSV' }));
    await waitFor(() => expect(bridge.saveProject).toHaveBeenCalledTimes(1));
    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import TSV' })).toBeDisabled());

    expect(bridge.audioOpen).toHaveBeenCalledTimes(1);
    mutationSave.resolve();

    await waitFor(() => expect(screen.getByText('new.wav')).toBeInTheDocument());
    expect(screen.queryByText('committed old import')).not.toBeInTheDocument();
    expect(bridge.saveProject.mock.calls.some(([saved]) => saved.annotations.some((item) => item.transcription === 'committed old import'))).toBe(true);
    expect(bridge.audioOpen.mock.calls.map(([path]) => path)).toEqual(['old.wav', 'new.wav']);
  });

  it('blocks project and playback mutations while a native replacement is pending', async () => {
    const identity = fakeIdentity('old.wav');
    const restored = createProject(identity);
    restored.annotations = [{
      ...restored.draft,
      id: 'saved',
      startMs: 100,
      endMs: 200,
      transcription: 'Saved annotation',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    }];
    const bridge = makeFakeBridge({ identity, restored });
    bridge.inspectAudio.mockImplementation(async (path) => fakeIdentity(path));
    const replacement = deferred<ReturnType<typeof fakeIdentity>>();
    bridge.audioOpen.mockImplementation(async (path) => {
      if (path === 'new.wav') return replacement.promise;
      bridge.currentNativePath = path;
      return fakeIdentity(path);
    });
    const paths = ['old.wav', 'new.wav'];
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => paths.shift() ?? null } });
    await openClip();
    await fireEvent.input(screen.getByLabelText('Notes'), { target: { value: 'old draft' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    await waitFor(() => expect(bridge.audioOpen).toHaveBeenCalledWith('new.wav'));

    expect(screen.getByLabelText('Notes')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Import TSV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show clock time' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    expect(screen.getByLabelText('Volume')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add annotation' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeDisabled();
    expect(screen.getByLabelText('Audio waveform').closest('.project-workspace')).toHaveProperty('inert', true);
    const savedRow = screen.getByRole('row', { name: 'Activate annotation Saved annotation' });
    await waitFor(() => expect(waveformSpies.setPreviewAnnotation).toHaveBeenLastCalledWith(null));
    const previewCallsWhileBusy = waveformSpies.setPreviewAnnotation.mock.calls.length;
    const boundariesWhileBusy = {
      start: (screen.getByLabelText('Start milliseconds') as HTMLInputElement).value,
      end: (screen.getByLabelText('End milliseconds') as HTMLInputElement).value
    };
    waveformInteractions.latest?.onAnnotationPreview('saved', true);
    waveformInteractions.latest?.onAnnotationActivate('saved');
    await Promise.resolve();
    expect(waveformSpies.setPreviewAnnotation).toHaveBeenCalledTimes(previewCallsWhileBusy);
    expect(savedRow).not.toHaveAttribute('aria-current');
    expect(screen.getByLabelText('Start milliseconds')).toHaveValue(Number(boundariesWhileBusy.start));
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(Number(boundariesWhileBusy.end));
    await fireEvent.input(screen.getByLabelText('Notes'), { target: { value: 'must be blocked' } });
    await fireEvent.keyDown(window, { key: 'i' });
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel analysis' }));

    bridge.currentNativePath = 'new.wav';
    replacement.resolve(fakeIdentity('new.wav'));
    await waitFor(() => expect(screen.getByLabelText('Notes')).toBeEnabled());
    expect(screen.getByText('old.wav')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Show clock time' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show decimal seconds' })).toBeInTheDocument());
    expect(bridge.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ notes: 'old draft' })
    }));
    expect(bridge.currentNativePath).toBe('old.wav');
  });

  it('requires explicit modified-recovery approval and refuses annotations outside the new duration', async () => {
    const restored = createProject(fakeIdentity('changed.wav', 2_000));
    restored.audioIdentity.size = 1;
    restored.annotations.push({
      ...restored.draft, id: 'late', startMs: 1_500, endMs: 1_800, transcription: 'late',
      createdAt: 'old', updatedAt: 'old'
    });
    const identity = { ...fakeIdentity('changed.wav', 1_000), size: 2 };
    const bridge = makeFakeBridge({ identity, restored });
    const confirmRecovery = vi.fn(async () => true);
    renderApp({ bridge, confirmRecovery, pickers: { ...nullPickers, audio: async () => 'changed.wav' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('does not fit the changed audio duration');
    expect(confirmRecovery).toHaveBeenCalledTimes(1);
    expect(bridge.analyzeAudio).not.toHaveBeenCalled();
    expect(bridge.audioOpen).not.toHaveBeenCalled();
  });

  it('cancels superseded analysis and ignores its late completion, progress, and error', async () => {
    const bridge = makeFakeBridge();
    bridge.inspectAudio.mockImplementation(async (path) => fakeIdentity(path));
    bridge.audioOpen.mockImplementation(async (path) => fakeIdentity(path));
    const oldAnalysis = deferred<PeakData>();
    const newAnalysis = deferred<PeakData>();
    bridge.analyzeAudio.mockImplementation((path) => path === 'old.wav' ? oldAnalysis.promise : newAnalysis.promise);
    const paths = ['old.wav', 'new.wav'];
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => paths.shift() ?? null } });

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    await waitFor(() => expect(bridge.analyzeAudio).toHaveBeenCalledWith('old.wav'));
    bridge.emitProgress({ processedMs: 50, durationMs: 100 });
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50'));
    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    await waitFor(() => expect(bridge.cancelAnalysis).toHaveBeenCalledTimes(1));
    newAnalysis.resolve(fakePeaks());
    await waitFor(() => expect(screen.getByText('new.wav')).toBeInTheDocument());
    oldAnalysis.reject(new Error('stale failure'));
    await Promise.resolve();

    expect(screen.queryByText('stale failure')).not.toBeInTheDocument();
    expect(bridge.audioOpen).toHaveBeenCalledTimes(1);
    expect(bridge.audioOpen).toHaveBeenCalledWith('new.wav');
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
  });

  it('serializes raced native opens so the newest operation is the final native and visible clip', async () => {
    const bridge = makeFakeBridge();
    bridge.inspectAudio.mockImplementation(async (path) => fakeIdentity(path));
    const firstOpen = deferred<ReturnType<typeof fakeIdentity>>();
    const settled: string[] = [];
    bridge.audioOpen.mockImplementation((path) => {
      if (path === 'first.wav') return firstOpen.promise.then((identity) => { settled.push(path); return identity; });
      settled.push(path);
      return Promise.resolve(fakeIdentity(path));
    });
    const paths = ['first.wav', 'second.wav'];
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => paths.shift() ?? null } });

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    await waitFor(() => expect(bridge.audioOpen).toHaveBeenCalledWith('first.wav'));
    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    await waitFor(() => expect(bridge.analyzeAudio).toHaveBeenCalledWith('second.wav'));
    expect(bridge.audioOpen).toHaveBeenCalledTimes(1);

    firstOpen.resolve(fakeIdentity('first.wav'));
    await waitFor(() => expect(bridge.audioOpen).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('second.wav')).toBeInTheDocument());
    expect(bridge.audioOpen.mock.calls.map(([path]) => path)).toEqual(['first.wav', 'second.wav']);
    expect(settled).toEqual(['first.wav', 'second.wav']);
  });

  it('restores the prior native path and playback when a superseding analysis fails', async () => {
    const bridge = makeFakeBridge();
    bridge.inspectAudio.mockImplementation(async (path) => fakeIdentity(path));
    const firstOpen = deferred<ReturnType<typeof fakeIdentity>>();
    bridge.audioOpen.mockImplementation(async (path) => {
      if (path === 'first.wav') {
        const identity = await firstOpen.promise;
        bridge.currentNativePath = path;
        bridge.snapshot = { ...bridge.snapshot, state: 'paused', positionMs: 0, loopRange: null, volume: 1 };
        return identity;
      }
      bridge.currentNativePath = path;
      bridge.snapshot = { ...bridge.snapshot, state: 'paused', positionMs: 0, durationMs: 1_000, loopRange: null };
      return fakeIdentity(path);
    });
    bridge.analyzeAudio.mockImplementation(async (path) => {
      if (path === 'bad.wav') throw new Error('newer analysis failed');
      return fakePeaks();
    });
    const paths = ['old.wav', 'first.wav', 'bad.wav'];
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => paths.shift() ?? null } });
    await openClip();
    bridge.snapshot = {
      state: 'playing', positionMs: 321, durationMs: 1_000,
      loopRange: { startMs: 100, endMs: 400 }, volume: 0.4, underruns: 0
    };

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    await waitFor(() => expect(bridge.audioOpen).toHaveBeenCalledWith('first.wav'));
    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    expect(await screen.findByRole('alert', { name: 'Application error' })).toHaveTextContent('newer analysis failed');

    firstOpen.resolve(fakeIdentity('first.wav'));
    await waitFor(() => expect(bridge.currentNativePath).toBe('old.wav'));
    expect(screen.getByText('old.wav')).toBeInTheDocument();
    await waitFor(() => expect(bridge.snapshot).toMatchObject({
      state: 'playing', positionMs: 321, loopRange: { startMs: 100, endMs: 400 }, volume: 0.4
    }));
    expect(bridge.audioOpen.mock.calls.map(([path]) => path)).toEqual(['old.wav', 'first.wav', 'old.wav']);
    expect(bridge.audioClose).not.toHaveBeenCalled();
  });

  it('rolls a mismatched replacement back to the prior native path and playback', async () => {
    const bridge = makeFakeBridge();
    bridge.inspectAudio.mockImplementation(async (path) => fakeIdentity(path));
    bridge.audioOpen.mockImplementation(async (path) => {
      bridge.currentNativePath = path;
      bridge.snapshot = { ...bridge.snapshot, state: 'paused', positionMs: 0, durationMs: 1_000, loopRange: null };
      return path === 'new.wav' ? { ...fakeIdentity(path), size: 101 } : fakeIdentity(path);
    });
    const paths = ['old.wav', 'new.wav'];
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => paths.shift() ?? null } });
    await openClip();
    bridge.snapshot = {
      state: 'paused', positionMs: 222, durationMs: 1_000,
      loopRange: { startMs: 50, endMs: 250 }, volume: 0.25, underruns: 0
    };

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));

    expect(await screen.findByRole('alert', { name: 'Application error' })).toHaveTextContent(/source audio changed/i);
    expect(screen.getByText('old.wav')).toBeInTheDocument();
    expect(bridge.currentNativePath).toBe('old.wav');
    expect(bridge.snapshot).toMatchObject({
      state: 'paused', positionMs: 222, loopRange: { startMs: 50, endMs: 250 }, volume: 0.25
    });
    expect(bridge.audioClose).not.toHaveBeenCalled();
  });

  it('surfaces both the candidate failure and an unsuccessful prior-audio rollback', async () => {
    const bridge = makeFakeBridge();
    bridge.inspectAudio.mockImplementation(async (path) => fakeIdentity(path));
    let oldOpenCount = 0;
    bridge.audioOpen.mockImplementation(async (path) => {
      if (path === 'old.wav' && ++oldOpenCount > 1) throw new Error('old file is no longer readable');
      bridge.currentNativePath = path;
      return path === 'new.wav' ? { ...fakeIdentity(path), size: 101 } : fakeIdentity(path);
    });
    const paths = ['old.wav', 'new.wav'];
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => paths.shift() ?? null } });
    await openClip();

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));

    const alert = await screen.findByRole('alert', { name: 'Application error' });
    expect(alert).toHaveTextContent('Source audio changed while opening');
    expect(alert).toHaveTextContent('Restoring the previous audio failed');
    expect(alert).toHaveTextContent('old file is no longer readable');
    expect(screen.getByText('old.wav')).toBeInTheDocument();
    expect(bridge.currentNativePath).toBe('new.wav');
  });

  it('restores the prior clip before a newer queued native open becomes final', async () => {
    const bridge = makeFakeBridge();
    bridge.inspectAudio.mockImplementation(async (path) => fakeIdentity(path));
    const firstOpen = deferred<ReturnType<typeof fakeIdentity>>();
    bridge.audioOpen.mockImplementation(async (path) => {
      if (path === 'first.wav') {
        const identity = await firstOpen.promise;
        bridge.currentNativePath = path;
        return identity;
      }
      bridge.currentNativePath = path;
      return fakeIdentity(path);
    });
    const paths = ['old.wav', 'first.wav', 'second.wav'];
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => paths.shift() ?? null } });
    await openClip();

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    await waitFor(() => expect(bridge.audioOpen).toHaveBeenCalledWith('first.wav'));
    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    await waitFor(() => expect(bridge.analyzeAudio).toHaveBeenCalledWith('second.wav'));
    firstOpen.resolve(fakeIdentity('first.wav'));

    await waitFor(() => expect(screen.getByText('second.wav')).toBeInTheDocument());
    expect(bridge.currentNativePath).toBe('second.wav');
    expect(bridge.audioOpen.mock.calls.map(([path]) => path)).toEqual([
      'old.wav', 'first.wav', 'old.wav', 'second.wav'
    ]);
  });

  it('rejects invalid peak geometry before native open and leaves the current UI untouched', async () => {
    const bridge = makeFakeBridge();
    bridge.analyzeAudio.mockResolvedValue({ ...fakePeaks(), framesPerPeak: 11 });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/waveform.*does not match/i);
    expect(screen.getByText('Open an MP3 or WAV file to begin.')).toBeInTheDocument();
    expect(bridge.audioOpen).not.toHaveBeenCalled();
  });

  it('rejects peak data whose frame count is materially shorter than the inspected duration', async () => {
    const bridge = makeFakeBridge();
    bridge.analyzeAudio.mockResolvedValue({
      ...fakePeaks(),
      totalFrames: 1,
      channels: [[-0.1, 0.1]]
    });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/waveform.*does not match/i);
    expect(screen.getByText('Open an MP3 or WAV file to begin.')).toBeInTheDocument();
    expect(bridge.audioOpen).not.toHaveBeenCalled();
  });

  it('rejects a changed native-open identity before publishing and closes mismatched playback', async () => {
    const bridge = makeFakeBridge();
    bridge.audioOpen.mockResolvedValue({ ...fakeIdentity(), size: 101 });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/source audio changed/i);
    expect(screen.getByText('Open an MP3 or WAV file to begin.')).toBeInTheDocument();
    expect(bridge.audioClose).toHaveBeenCalledTimes(1);
  });

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
    bridge.audioSeek.mockClear();
    bridge.audioPlay.mockClear();
    bridge.audioPause.mockClear();

    await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(nativeOrder).toEqual(['seek:250', 'play']));

    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(nativeOrder).toEqual(['seek:250', 'play', 'pause']));

    await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(nativeOrder).toEqual([
      'seek:250', 'play', 'pause', 'seek:250', 'play'
    ]));
  });

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
    bridge.audioSeek.mockClear();
    bridge.audioPlay.mockClear();

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
    bridge.audioSeek.mockClear();
    bridge.audioPlay.mockClear();
    bridge.audioSeek.mockRejectedValueOnce(new Error('seek failed'));

    await fireEvent.click(screen.getByRole('button', { name: 'Play' }));

    expect(await screen.findByRole('alert', { name: 'Application error' }))
      .toHaveTextContent('seek failed');
    expect(bridge.audioPlay).not.toHaveBeenCalled();
  });

  it('handles global shortcuts but ignores text controls and IME composition', async () => {
    const bridge = makeFakeBridge();
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });
    await openClip();

    const editor = screen.getByLabelText('Transcription');
    await fireEvent.keyDown(editor, { code: 'Space', key: ' ' });
    await fireEvent.keyDown(window, { code: 'Space', key: ' ', isComposing: true });
    expect(bridge.audioPlay).not.toHaveBeenCalled();
    const space = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
    window.dispatchEvent(space);
    await waitFor(() => expect(bridge.audioPlay).toHaveBeenCalledTimes(1));
    expect(space.defaultPrevented).toBe(true);

    bridge.snapshot = { ...bridge.snapshot, positionMs: 200 };
    const snapshotsBeforeIn = bridge.audioSnapshot.mock.calls.length;
    await waitFor(() => expect(bridge.audioSnapshot.mock.calls.length).toBeGreaterThan(snapshotsBeforeIn));
    await fireEvent.keyDown(window, { key: 'i' });
    bridge.snapshot = { ...bridge.snapshot, positionMs: 350 };
    const snapshotsBeforeOut = bridge.audioSnapshot.mock.calls.length;
    await waitFor(() => expect(bridge.audioSnapshot.mock.calls.length).toBeGreaterThan(snapshotsBeforeOut));
    await fireEvent.keyDown(window, { key: 'o' });
    expect(screen.getByLabelText('Start milliseconds')).toHaveValue(200);
    expect(screen.getByLabelText('End milliseconds')).toHaveValue(350);
    await fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });
    expect(bridge.audioSeek).toHaveBeenLastCalledWith(1_000);
    await fireEvent.keyDown(window, { key: 'Enter' });
    expect(bridge.audioPlay).toHaveBeenCalledTimes(1);
  });

  it('ignores shortcuts inside empty and plaintext-only contenteditable regions', async () => {
    const bridge = makeFakeBridge();
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });
    await openClip();
    const emptyEditable = document.createElement('div');
    emptyEditable.setAttribute('contenteditable', '');
    const plaintextEditable = document.createElement('div');
    plaintextEditable.setAttribute('contenteditable', 'plaintext-only');
    const child = document.createElement('span');
    plaintextEditable.append(child);
    document.body.append(emptyEditable, plaintextEditable);

    await fireEvent.keyDown(emptyEditable, { code: 'Space', key: ' ' });
    await fireEvent.keyDown(child, { code: 'Space', key: ' ' });

    expect(bridge.audioPlay).not.toHaveBeenCalled();
    expect(bridge.audioPause).not.toHaveBeenCalled();
    emptyEditable.remove();
    plaintextEditable.remove();
  });

  it('flushes recovery and disposes listeners/audio exactly once on reentrant close', async () => {
    const bridge = makeFakeBridge();
    const close = makeFakeLifecycle();
    render(App, {
      bridge, lifecycle: close.lifecycle,
      pickers: { ...nullPickers, audio: async () => 'clip.wav' }
    });
    await openClip();
    await fireEvent.input(screen.getByLabelText('Notes'), { target: { value: 'flush me' } });
    const progressUnlisten = await bridge.onAnalysisProgress.mock.results[0].value;

    const first = close.triggerClose();
    const second = close.triggerClose();
    await Promise.all([first.result, second.result]);

    expect(first.event.preventDefault).toHaveBeenCalledTimes(1);
    expect(second.event.preventDefault).toHaveBeenCalledTimes(1);
    expect(bridge.saveProject).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.objectContaining({ notes: 'flush me' }) }));
    expect(bridge.audioClose).toHaveBeenCalledTimes(1);
    expect(progressUnlisten).toHaveBeenCalledTimes(1);
    expect(close.closeUnlisten).toHaveBeenCalledTimes(1);
    expect(close.lifecycle.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps the window and audio open when close recovery cannot be saved', async () => {
    const bridge = makeFakeBridge();
    const close = makeFakeLifecycle();
    render(App, {
      bridge, lifecycle: close.lifecycle,
      pickers: { ...nullPickers, audio: async () => 'clip.wav' }
    });
    await openClip();
    await fireEvent.input(screen.getByLabelText('Notes'), { target: { value: 'must survive close' } });
    bridge.saveProject.mockRejectedValueOnce(new Error('cannot save recovery'));

    const request = close.triggerClose();
    await request.result;

    expect(request.event.preventDefault).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('alert', { name: 'Application error' })).toHaveTextContent('cannot save recovery');
    expect(bridge.audioClose).not.toHaveBeenCalled();
    expect(close.lifecycle.destroy).not.toHaveBeenCalled();
  });

  it('waits for stale native rollback before a failed close clears for retry', async () => {
    const bridge = makeFakeBridge();
    const close = makeFakeLifecycle();
    bridge.inspectAudio.mockImplementation(async (path) => fakeIdentity(path));
    const replacement = deferred<ReturnType<typeof fakeIdentity>>();
    bridge.audioOpen.mockImplementation(async (path) => {
      if (path === 'new.wav') {
        const identity = await replacement.promise;
        bridge.currentNativePath = path;
        return identity;
      }
      bridge.currentNativePath = path;
      return fakeIdentity(path);
    });
    const paths = ['old.wav', 'new.wav'];
    render(App, {
      bridge, lifecycle: close.lifecycle,
      pickers: { ...nullPickers, audio: async () => paths.shift() ?? null }
    });
    await openClip();
    await fireEvent.input(screen.getByLabelText('Notes'), { target: { value: 'must survive' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    await waitFor(() => expect(bridge.audioOpen).toHaveBeenCalledWith('new.wav'));
    bridge.saveProject.mockRejectedValueOnce(new Error('cannot save recovery'));

    const failedClose = close.triggerClose();
    let closeSettled = false;
    void failedClose.result.then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(close.lifecycle.destroy).not.toHaveBeenCalled();

    replacement.resolve(fakeIdentity('new.wav'));
    await failedClose.result;
    expect(bridge.currentNativePath).toBe('old.wav');
    expect(bridge.audioClose).not.toHaveBeenCalled();
    expect(close.lifecycle.destroy).not.toHaveBeenCalled();

    const retry = close.triggerClose();
    await retry.result;
    expect(retry.event.preventDefault).toHaveBeenCalledTimes(1);
    expect(bridge.currentNativePath).toBeNull();
    expect(bridge.audioClose).toHaveBeenCalledTimes(1);
    expect(close.lifecycle.destroy).toHaveBeenCalledTimes(1);
  });

  it('waits for stale native rollback before the final close and cannot be resurrected', async () => {
    const bridge = makeFakeBridge();
    const close = makeFakeLifecycle();
    bridge.inspectAudio.mockImplementation(async (path) => fakeIdentity(path));
    const replacement = deferred<ReturnType<typeof fakeIdentity>>();
    bridge.audioOpen.mockImplementation(async (path) => {
      if (path === 'new.wav') {
        const identity = await replacement.promise;
        bridge.currentNativePath = path;
        return identity;
      }
      bridge.currentNativePath = path;
      return fakeIdentity(path);
    });
    const paths = ['old.wav', 'new.wav'];
    render(App, {
      bridge, lifecycle: close.lifecycle,
      pickers: { ...nullPickers, audio: async () => paths.shift() ?? null }
    });
    await openClip();
    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    await waitFor(() => expect(bridge.audioOpen).toHaveBeenCalledWith('new.wav'));

    const closeRequest = close.triggerClose();
    replacement.resolve(fakeIdentity('new.wav'));
    await closeRequest.result;

    expect(bridge.audioOpen.mock.calls.map(([path]) => path)).toEqual(['old.wav', 'new.wav', 'old.wav']);
    expect(bridge.audioClose).toHaveBeenCalledTimes(1);
    expect(bridge.currentNativePath).toBeNull();
    expect(close.lifecycle.destroy).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(bridge.currentNativePath).toBeNull();
  });
});
