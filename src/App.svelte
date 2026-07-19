<script lang="ts">
  import { get } from 'svelte/store';
  import { onMount } from 'svelte';
  import {
    chooseTsvExportPath,
    pickAudioPath,
    pickTsvPath,
    tauriBridge,
    type AnalysisProgress,
    type NativeBridge,
    type PeakData
  } from './lib/bridge/native';
  import { tauriLifecycle, type CloseRequestEvent, type LifecycleAdapter } from './lib/bridge/lifecycle';
  import AnnotationDashboard from './lib/components/AnnotationDashboard.svelte';
  import AnnotationTable from './lib/components/AnnotationTable.svelte';
  import ClipToolbar from './lib/components/ClipToolbar.svelte';
  import ErrorBanner from './lib/components/ErrorBanner.svelte';
  import TimelineWorkspace from './lib/components/TimelineWorkspace.svelte';
  import { mergeImportedTsv } from './lib/domain/importTsv';
  import { createProject } from './lib/domain/project';
  import type { AnnotationDraft, AudioIdentity, Project, Selection } from './lib/domain/types';
  import { validateDraft } from './lib/domain/validation';
  import { AudioSession } from './lib/state/audioSession';
  import { ProjectStore } from './lib/state/projectStore';

  interface PickerSet {
    audio(): Promise<string | null>;
    tsv(): Promise<string | null>;
    exportTsv(defaultPath?: string): Promise<string | null>;
  }

  interface Props {
    bridge?: NativeBridge;
    pickers?: PickerSet;
    lifecycle?: LifecycleAdapter;
    confirmRecovery?: (message: string) => boolean | Promise<boolean>;
    id?: () => string;
    now?: () => string;
  }

  const productionPickers: PickerSet = {
    audio: pickAudioPath,
    tsv: pickTsvPath,
    exportTsv: chooseTsvExportPath
  };

  let {
    bridge = tauriBridge,
    pickers = productionPickers,
    lifecycle = tauriLifecycle,
    confirmRecovery = (message) => window.confirm(message),
    id = () => crypto.randomUUID(),
    now = () => new Date().toISOString()
  }: Props = $props();

  const projectStore = new ProjectStore({ saveProject: (value) => bridge.saveProject(value) }, () => id());
  const audioSession = new AudioSession({
    audioPlay: () => bridge.audioPlay(),
    audioPause: () => bridge.audioPause(),
    audioSeek: (milliseconds) => bridge.audioSeek(milliseconds),
    audioSetLoop: (selection) => bridge.audioSetLoop(selection),
    audioClearLoop: () => bridge.audioClearLoop(),
    audioSetVolume: (volume) => bridge.audioSetVolume(volume),
    audioSnapshot: () => bridge.audioSnapshot(),
    audioClose: () => bridge.audioClose()
  });
  let peaks = $state<PeakData | null>(null);
  let analysisProgress = $state<AnalysisProgress | null>(null);
  let status = $state('');
  let persistentError = $state<string | null>(null);
  let pickerRequest = 0;
  let latestStartedPicker = 0;
  let operationGeneration = 0;
  let activeAnalysisGeneration: number | null = null;
  let latestQueuedOpenGeneration = 0;
  let audioOpenQueue: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | null = null;
  let cleanupRequested = false;
  let analysisUnlisten: (() => void) | null = null;
  let closeUnlisten: (() => void) | null = null;
  let windowListenerInstalled = false;
  let lastLoopSelection = '';
  let lastSaveError: string | null = null;
  let lastPlaybackError: string | null = null;

  let project = $derived($projectStore.project);
  let playback = $derived($audioSession);
  let filename = $derived(project ? basename(project.audioIdentity.canonicalPath) : null);
  let analysisPercent = $derived.by(() => {
    if (!analysisProgress) return null;
    if (!Number.isFinite(analysisProgress.durationMs) || analysisProgress.durationMs <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round(analysisProgress.processedMs / analysisProgress.durationMs * 100)));
  });
  let tableAnnotations = $derived.by(() => project ? project.annotations.map((annotation) => ({
    id: annotation.id,
    startMs: annotation.startMs,
    endMs: annotation.endMs,
    transcription: annotation.transcription,
    speaker: project.speakers.find((speaker) => speaker.id === annotation.speakerId)?.label ?? 'none'
  })) : []);
  let canLoop = $derived(Boolean(project && (project.activeSelection || (
    Number.isInteger(project.draft.startMs) && Number.isInteger(project.draft.endMs)
    && project.draft.startMs >= 0 && project.draft.endMs > project.draft.startMs
    && project.draft.endMs <= project.audioIdentity.durationMs
  ))));

  $effect(() => {
    const saveError = $projectStore.saveError;
    if (saveError && saveError !== lastSaveError) persistentError = saveError;
    lastSaveError = saveError;
  });

  $effect(() => {
    const nativeError = typeof playback.state === 'object' ? playback.state.error : null;
    if (nativeError && nativeError !== lastPlaybackError) persistentError = nativeError;
    lastPlaybackError = nativeError;
  });

  $effect(() => {
    const selection = project?.activeSelection ?? null;
    const loopEnabled = playback.loopRange !== null;
    if (!loopEnabled || !selection) {
      if (!loopEnabled) lastLoopSelection = '';
      return;
    }
    const key = `${selection.startMs}:${selection.endMs}`;
    if (key === lastLoopSelection) return;
    lastLoopSelection = key;
    void reportPromise(audioSession.setLoop(selection));
  });

  function basename(path: string): string {
    return path.split(/[\\/]/).at(-1) ?? path;
  }

  function errorText(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && 'message' in error) return String(error.message);
    return 'The operation failed';
  }

  function sameAudioIdentity(left: AudioIdentity, right: AudioIdentity): boolean {
    return left.canonicalPath === right.canonicalPath
      && left.size === right.size
      && left.modifiedMs === right.modifiedMs
      && left.durationMs === right.durationMs
      && left.sampleRate === right.sampleRate
      && left.channels === right.channels;
  }

  function validatePeaks(value: PeakData, identity: AudioIdentity): void {
    const expectedFramesPerPeak = Math.max(1, Math.floor(identity.sampleRate / 100));
    const expectedPairs = Math.ceil(value.totalFrames / expectedFramesPerPeak);
    const valid = Number.isInteger(value.totalFrames)
      && value.totalFrames > 0
      && value.totalFrames <= identity.sampleRate * 30 * 60
      && value.durationMs === identity.durationMs
      && value.sampleRate === identity.sampleRate
      && value.framesPerPeak === expectedFramesPerPeak
      && value.channels.length === identity.channels
      && value.channels.every((channel) => channel.length === expectedPairs * 2
        && channel.every((sample) => Number.isFinite(sample) && sample >= -1 && sample <= 1));
    if (!valid) throw new Error('Analyzed waveform data does not match the inspected audio');
  }

  function isCurrent(generation: number): boolean {
    return generation === operationGeneration && !closePromise;
  }

  function queueNativeOpen(path: string, identity: AudioIdentity, generation: number): Promise<AudioIdentity | null> {
    latestQueuedOpenGeneration = generation;
    const operation = audioOpenQueue.then(async () => {
      if (!isCurrent(generation)) {
        if (latestQueuedOpenGeneration === generation) {
          try { await bridge.audioClose(); } catch { /* A cancelled queued open must not leave an older queued side effect alive. */ }
        }
        return null;
      }
      const openedIdentity = await bridge.audioOpen(path);
      if (!sameAudioIdentity(openedIdentity, identity)) {
        if (isCurrent(generation) || latestQueuedOpenGeneration === generation) {
          try { await bridge.audioClose(); } catch { /* Preserve the primary source-change error. */ }
        }
        throw new Error('Source audio changed while opening; retry the operation');
      }
      if (!isCurrent(generation)) {
        if (latestQueuedOpenGeneration === generation) {
          try { await bridge.audioClose(); } catch { /* A cancelled open must not keep mismatched playback alive. */ }
        }
        return null;
      }
      return openedIdentity;
    });
    audioOpenQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  function installDisposer(kind: 'analysis' | 'close', disposer: () => void): void {
    let called = false;
    const once = () => {
      if (called) return;
      called = true;
      disposer();
    };
    if (cleanupRequested) once();
    else if (kind === 'analysis') analysisUnlisten = once;
    else closeUnlisten = once;
  }

  function disposeListeners(): void {
    cleanupRequested = true;
    analysisUnlisten?.();
    analysisUnlisten = null;
    closeUnlisten?.();
    closeUnlisten = null;
    if (windowListenerInstalled) {
      window.removeEventListener('keydown', globalKeydown);
      windowListenerInstalled = false;
    }
  }

  onMount(() => {
    window.addEventListener('keydown', globalKeydown);
    windowListenerInstalled = true;
    void Promise.resolve().then(() => bridge.onAnalysisProgress((progress) => {
      if (activeAnalysisGeneration !== null && isCurrent(activeAnalysisGeneration)) analysisProgress = progress;
    })).then((unlisten) => installDisposer('analysis', unlisten)).catch((error) => {
      if (!cleanupRequested) persistentError = errorText(error);
    });
    void Promise.resolve().then(() => lifecycle.onCloseRequested(requestClose))
      .then((unlisten) => installDisposer('close', unlisten))
      .catch((error) => { if (!cleanupRequested) persistentError = errorText(error); });
    return () => {
      operationGeneration += 1;
      disposeListeners();
      if (!closePromise) {
        void bridge.cancelAnalysis().catch(() => undefined);
        void audioSession.close().catch(() => undefined);
      }
    };
  });

  function validateRecoveredProject(value: Project, changed: boolean): void {
    const invalidDuration = (selection: Selection | null): boolean => Boolean(selection && (
      !Number.isInteger(selection.startMs) || !Number.isInteger(selection.endMs)
      || selection.startMs < 0 || selection.endMs <= selection.startMs
      || selection.endMs > value.audioIdentity.durationMs
    ));
    if (invalidDuration(value.activeSelection)) {
      throw new Error('The recovered selection does not fit the changed audio duration');
    }
    for (const annotation of value.annotations) {
      const draft: AnnotationDraft = {
        startMs: annotation.startMs, endMs: annotation.endMs, eventType: annotation.eventType,
        transcription: annotation.transcription, intelligibility: annotation.intelligibility,
        speakerId: annotation.speakerId, overlap: annotation.overlap, confidence: annotation.confidence,
        acousticTagIds: annotation.acousticTagIds, notes: annotation.notes
      };
      if (Object.keys(validateDraft(draft, value)).length) {
        throw new Error(`Recovered annotation ${annotation.id} does not fit the ${changed ? 'changed audio duration' : 'audio project'}`);
      }
    }
    const draftStarted = value.draft.endMs !== 0 || value.draft.startMs !== 0
      || value.draft.transcription !== '' || value.draft.notes !== '' || value.activeSelection !== null;
    if (draftStarted && Object.keys(validateDraft(value.draft, value)).length) {
      throw new Error(`The recovered draft does not fit the ${changed ? 'changed audio duration' : 'audio project'}`);
    }
    if (value.activeAnnotationId && !value.annotations.some((item) => item.id === value.activeAnnotationId)) {
      throw new Error('The recovered active annotation no longer exists');
    }
  }

  async function openAudio(): Promise<void> {
    const request = ++pickerRequest;
    let path: string | null;
    try {
      path = await pickers.audio();
    } catch (error) {
      if (request >= latestStartedPicker) persistentError = errorText(error);
      return;
    }
    if (!path) return;
    if (request < latestStartedPicker) return;
    if (!/\.(mp3|wav)$/i.test(path)) {
      persistentError = 'Choose a single MP3 or WAV audio file';
      return;
    }

    latestStartedPicker = request;
    const generation = ++operationGeneration;
    if (activeAnalysisGeneration !== null) {
      try { await bridge.cancelAnalysis(); } catch { /* Starting analysis also supersedes native work. */ }
      if (!isCurrent(generation)) return;
    }
    activeAnalysisGeneration = generation;
    try {
      const identity = await bridge.inspectAudio(path);
      if (!isCurrent(generation)) return;
      const current = get(projectStore).project;
      const restored = current?.audioIdentity.canonicalPath === identity.canonicalPath
        ? current
        : await bridge.loadProject(identity.canonicalPath);
      if (!isCurrent(generation)) return;
      const changed = Boolean(restored && (
        restored.audioIdentity.size !== identity.size || restored.audioIdentity.modifiedMs !== identity.modifiedMs
      ));
      if (changed && !await confirmRecovery('The source audio changed. Reuse its existing annotations and regenerate the waveform?')) return;
      if (!isCurrent(generation)) return;
      const nextProject = restored ? { ...restored, audioIdentity: identity } : createProject(identity);
      validateRecoveredProject(nextProject, changed);
      analysisProgress = { processedMs: 0, durationMs: identity.durationMs };
      const nextPeaks = await bridge.analyzeAudio(path);
      if (!isCurrent(generation)) return;
      validatePeaks(nextPeaks, identity);
      if (current && !await projectStore.flush()) {
        throw new Error(get(projectStore).saveError ?? 'The current project could not be saved');
      }
      if (!isCurrent(generation)) return;
      const openedIdentity = await queueNativeOpen(path, identity, generation);
      if (!openedIdentity) return;
      if (!isCurrent(generation)) return;
      projectStore.open(nextProject);
      peaks = nextPeaks;
      await audioSession.refresh();
      audioSession.startPolling();
      status = `Opened ${basename(path)}`;
    } catch (error) {
      if (isCurrent(generation)) persistentError = errorText(error);
    } finally {
      if (activeAnalysisGeneration === generation) activeAnalysisGeneration = null;
      if (isCurrent(generation)) analysisProgress = null;
    }
  }

  async function cancelAnalysis(): Promise<void> {
    if (activeAnalysisGeneration === null) return;
    operationGeneration += 1;
    activeAnalysisGeneration = null;
    analysisProgress = null;
    try {
      await bridge.cancelAnalysis();
      status = 'Waveform analysis cancelled';
    } catch (error) {
      persistentError = errorText(error);
    }
  }

  async function importTsv(): Promise<void> {
    const current = get(projectStore).project;
    if (!current) return;
    try {
      const path = await pickers.tsv();
      if (!path) return;
      const imported = await bridge.readTsv(path, current.exportSettings.multilinePolicy);
      const succeeded = await projectStore.mutateProject((value) => mergeImportedTsv(value, imported, id, now()));
      if (!succeeded) {
        persistentError = get(projectStore).saveError ?? 'The TSV import could not be saved';
        return;
      }
      status = `Imported ${imported.annotations.length} annotation${imported.annotations.length === 1 ? '' : 's'}`;
    } catch (error) {
      persistentError = errorText(error);
    }
  }

  async function exportTsv(): Promise<void> {
    const current = get(projectStore).project;
    if (!current) return;
    try {
      const defaultPath = `${basename(current.audioIdentity.canonicalPath).replace(/\.[^.]+$/, '')}.tsv`;
      const path = await pickers.exportTsv(defaultPath);
      if (!path) return;
      await bridge.writeTsv(path, current);
      status = `Exported ${current.annotations.length} annotation${current.annotations.length === 1 ? '' : 's'}`;
    } catch (error) {
      persistentError = errorText(error);
    }
  }

  async function toggleFormat(): Promise<void> {
    const succeeded = await projectStore.mutateProject((value) => ({
      ...value,
      displayFormat: value.displayFormat === 'seconds' ? 'clock' : 'seconds'
    }));
    if (!succeeded) persistentError = get(projectStore).saveError ?? 'The display setting could not be saved';
  }

  function setSelection(selection: Selection): void {
    const current = get(projectStore).project;
    if (!current || current.audioIdentity.durationMs < 1) return;
    const startMs = Math.min(current.audioIdentity.durationMs - 1, Math.max(0, Math.round(selection.startMs)));
    const endMs = Math.min(current.audioIdentity.durationMs, Math.max(startMs + 1, Math.round(selection.endMs)));
    projectStore.setSelection({ startMs, endMs });
  }

  function reportPromise(request: Promise<unknown>): Promise<void> {
    return request.then(() => undefined).catch((error) => { persistentError = errorText(error); });
  }

  function togglePlay(): void {
    void reportPromise(playback.state === 'playing' ? audioSession.pause() : audioSession.play());
  }

  function toggleLoop(): void {
    let next = playback.loopRange ? null : project?.activeSelection ?? null;
    if (!playback.loopRange && !next && project && canLoop) {
      next = { startMs: project.draft.startMs, endMs: project.draft.endMs };
      setSelection(next);
    }
    lastLoopSelection = next ? `${next.startMs}:${next.endMs}` : '';
    void reportPromise(audioSession.setLoop(next));
  }

  function globalKeydown(event: KeyboardEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    const editable = target?.closest('[contenteditable]');
    const editableValue = editable?.getAttribute('contenteditable')?.toLowerCase();
    if (event.isComposing || target?.closest('input, textarea, select')
      || (editable && editableValue !== 'false')
      || (target instanceof HTMLElement && target.isContentEditable)) return;
    const current = get(projectStore).project;
    if (!current) return;
    const snapshot = get(audioSession);
    if (event.code === 'Space') {
      event.preventDefault();
      void reportPromise(snapshot.state === 'playing' ? audioSession.pause() : audioSession.play());
      return;
    }
    if (event.key.toLowerCase() === 'i' && current.audioIdentity.durationMs > 0) {
      const startMs = Math.min(current.audioIdentity.durationMs - 1, Math.max(0, snapshot.positionMs));
      const existingEnd = current.activeSelection?.endMs ?? startMs + 1;
      setSelection({ startMs, endMs: Math.min(current.audioIdentity.durationMs, Math.max(startMs + 1, existingEnd)) });
      return;
    }
    if (event.key.toLowerCase() === 'o' && current.activeSelection) {
      const endMs = Math.min(current.audioIdentity.durationMs, Math.max(0, snapshot.positionMs));
      if (endMs > current.activeSelection.startMs) setSelection({ ...current.activeSelection, endMs });
      return;
    }
    if (event.key.toLowerCase() === 'l') {
      const next = snapshot.loopRange ? null : current.activeSelection;
      if (next || snapshot.loopRange) {
        lastLoopSelection = next ? `${next.startMs}:${next.endMs}` : '';
        void reportPromise(audioSession.setLoop(next));
      }
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const magnitude = event.shiftKey ? 1_000 : 50;
      const delta = event.key === 'ArrowLeft' ? -magnitude : magnitude;
      const position = Math.min(current.audioIdentity.durationMs, Math.max(0, snapshot.positionMs + delta));
      void reportPromise(audioSession.seek(position));
    }
  }

  function requestClose(event: CloseRequestEvent): Promise<void> {
    if (closePromise) return closePromise;
    event.preventDefault();
    const attempt = shutdown();
    const shared = attempt.then(() => undefined);
    closePromise = shared;
    void attempt.then((completed) => {
      if (!completed && closePromise === shared) closePromise = null;
    });
    return shared;
  }

  async function shutdown(): Promise<boolean> {
    operationGeneration += 1;
    const hadAnalysis = activeAnalysisGeneration !== null;
    activeAnalysisGeneration = null;
    analysisProgress = null;
    if (hadAnalysis) {
      try { await bridge.cancelAnalysis(); } catch (error) { persistentError = errorText(error); }
    }
    let flushed = false;
    try { flushed = await projectStore.flush(); } catch (error) { persistentError = errorText(error); }
    if (!flushed) {
      persistentError = get(projectStore).saveError ?? 'The current project could not be saved before closing';
      return false;
    }
    try { await audioSession.close(); } catch (error) { persistentError = errorText(error); }
    disposeListeners();
    try { await lifecycle.destroy(); } catch (error) { persistentError = errorText(error); }
    return true;
  }

  const toolbarActions = {
    open: () => void openAudio(),
    importTsv: () => void importTsv(),
    togglePlay,
    toggleLoop,
    toggleFormat: () => void toggleFormat(),
    exportTsv: () => void exportTsv(),
    cancelAnalysis: () => void cancelAnalysis(),
    setVolume: (value: number) => void reportPromise(audioSession.setVolume(value))
  };
</script>

<svelte:head><title>Lightscribe</title></svelte:head>

<main class="app-shell">
  <h1 class="product-title">Lightscribe</h1>
  <ErrorBanner message={persistentError} dismiss={() => persistentError = null} />
  <ClipToolbar
    {filename}
    playing={playback.state === 'playing'}
    loopEnabled={playback.loopRange !== null}
    {canLoop}
    format={project?.displayFormat ?? 'seconds'}
    volume={playback.volume}
    {analysisPercent}
    actions={toolbarActions}
  />
  <div class="app-status" role="status" aria-label="Operation status" aria-live="polite">{status}</div>
  {#if project}
    <TimelineWorkspace
      durationMs={project.audioIdentity.durationMs}
      format={project.displayFormat}
      selection={project.activeSelection}
      onchange={setSelection}
      {peaks}
      playheadMs={playback.positionMs}
    />
    <AnnotationDashboard store={projectStore} />
    <AnnotationTable
      annotations={tableAnnotations}
      activeId={project.activeAnnotationId}
      onselect={(annotationId) => projectStore.selectAnnotation(annotationId)}
      onremove={(annotationId) => void projectStore.removeAnnotation(annotationId)}
    />
  {:else}
    <section class="empty-state">
      <p>Open an MP3 or WAV file to begin.</p>
    </section>
  {/if}
</main>
