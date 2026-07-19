import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import { createProject } from './lib/domain/project';
import type { PeakData } from './lib/bridge/native';
import { fakeIdentity, fakePeaks, makeFakeBridge, makeFakeLifecycle, nullPickers } from './test/fakeBridge';

vi.mock('./lib/waveform/wavesurferAdapter', () => ({
  createWaveformAdapter: () => ({
    setSelection: vi.fn(), setPlayhead: vi.fn(), setZoom: vi.fn(), destroy: vi.fn()
  })
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
}

describe('App', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('identifies the product and empty state without touching a live Tauri window', () => {
    renderApp();
    expect(screen.getByRole('heading', { name: 'Lightscribe' })).toBeInTheDocument();
    expect(screen.getByText('Open an MP3 or WAV file to begin.')).toBeInTheDocument();
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
    const multilinePolicy = screen.getByRole('combobox', { name: 'Multiline export policy' });
    expect(multilinePolicy).toHaveValue('escape');
    expect(multilinePolicy).toHaveTextContent('Escape line breaks as \\n');
    expect(multilinePolicy).toHaveTextContent('Replace line breaks with spaces');
    expect(multilinePolicy).toHaveTextContent('Preserve line breaks in quoted fields');
    await fireEvent.change(multilinePolicy, { target: { value: 'space' } });
    await waitFor(() => expect(bridge.saveProject).toHaveBeenCalledWith(expect.objectContaining({
      exportSettings: { multilinePolicy: 'space' }
    })));
    expect(screen.getByTestId('timeline-content').children).toHaveLength(4);
    await fireEvent.input(screen.getByLabelText('Start milliseconds'), { target: { value: '100' } });
    await fireEvent.input(screen.getByLabelText('End milliseconds'), { target: { value: '250' } });
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
    expect(screen.getByRole('combobox', { name: 'Multiline export policy' })).toHaveValue('space');
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

  it('waits for an immediate multiline policy save before exporting the authoritative project', async () => {
    const policySave = deferred<void>();
    const bridge = makeFakeBridge();
    bridge.saveProject.mockImplementationOnce(() => policySave.promise).mockResolvedValue(undefined);
    renderApp({
      bridge,
      pickers: { ...nullPickers, audio: async () => 'clip.wav', exportTsv: async () => 'clip.tsv' }
    });
    await openClip();

    const selector = screen.getByRole('combobox', { name: 'Multiline export policy' }) as HTMLSelectElement;
    const exportButton = screen.getByRole('button', { name: 'Export TSV' });
    selector.value = 'space';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
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

    const selector = screen.getByRole('combobox', { name: 'Multiline export policy' }) as HTMLSelectElement;
    const importButton = screen.getByRole('button', { name: 'Import TSV' });
    selector.value = 'quoted';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
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
    const bridge = makeFakeBridge();
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
    expect(screen.getByRole('combobox', { name: 'Multiline export policy' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    expect(screen.getByLabelText('Volume')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add annotation' })).toBeDisabled();
    expect(screen.getByLabelText('New speaker')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add acoustic tag' })).toBeDisabled();
    expect(screen.getByLabelText('Audio waveform').closest('.project-workspace')).toHaveProperty('inert', true);
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

  it('rejects a changed native-open identity before publishing and closes mismatched playback', async () => {
    const bridge = makeFakeBridge();
    bridge.audioOpen.mockResolvedValue({ ...fakeIdentity(), size: 101 });
    renderApp({ bridge, pickers: { ...nullPickers, audio: async () => 'clip.wav' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/source audio changed/i);
    expect(screen.getByText('Open an MP3 or WAV file to begin.')).toBeInTheDocument();
    expect(bridge.audioClose).toHaveBeenCalledTimes(1);
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
