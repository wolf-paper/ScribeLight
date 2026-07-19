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
    await fireEvent.click(screen.getByRole('button', { name: 'Import TSV' }));
    expect(await screen.findByText('imported')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Export TSV' }));
    expect(bridge.writeTsv).toHaveBeenCalledWith('clip.tsv', expect.objectContaining({
      annotations: expect.arrayContaining([expect.objectContaining({ transcription: 'うん!' }), expect.objectContaining({ transcription: 'imported' })])
    }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Operation status' })).toHaveTextContent('Exported 2 annotations'));
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
    expect(second.event.preventDefault).not.toHaveBeenCalled();
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
});
