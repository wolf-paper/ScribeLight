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
    type PeakData,
    type PlaybackSnapshot
  } from './lib/bridge/native';
  import { tauriLifecycle, type CloseRequestEvent, type LifecycleAdapter } from './lib/bridge/lifecycle';
  import AnnotationDashboard from './lib/components/AnnotationDashboard.svelte';
  import AnnotationTable from './lib/components/AnnotationTable.svelte';
  import ClipToolbar from './lib/components/ClipToolbar.svelte';
  import ErrorBanner from './lib/components/ErrorBanner.svelte';
  import TimelineWorkspace from './lib/components/TimelineWorkspace.svelte';
  import { mergeImportedTsv } from './lib/domain/importTsv';
  import { createProject } from './lib/domain/project';
  import type { AnnotationDraft, AudioIdentity, MultilinePolicy, Project, Selection } from './lib/domain/types';
  import { validateDraft } from './lib/domain/validation';
  import { formatUnknownError } from './lib/errors';
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
  let audioOpenQueue: Promise<void> = Promise.resolve();
  let transitionOwner: number | null = null;
  let transitionBusy = $state(false);
  let settingsBusy = $state(false);
  let multilinePolicyMutation: Promise<boolean> | null = null;
  let closePromise: Promise<void> | null = null;
  let cleanupRequested = false;
  let analysisUnlisten: (() => void) | null = null;
  let closeUnlisten: (() => void) | null = null;
  let windowListenerInstalled = false;
  let lastLoopSelection = '';
  let lastSaveError: string | null = null;
  let lastPlaybackError: string | null = null;
  let nativePreservationFailures = 0;

  class NativePreservationError extends Error {}

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
    if (transitionBusy) return;
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

  function beginTransition(owner: number): void {
    transitionOwner = owner;
    transitionBusy = true;
    projectStore.setMutationsBlocked(true);
  }

  function endTransition(owner: number): void {
    if (transitionOwner !== owner) return;
    transitionOwner = null;
    transitionBusy = false;
    projectStore.setMutationsBlocked(false);
  }

  async function restoreNativePlayback(
    priorIdentity: AudioIdentity | null,
    snapshot: PlaybackSnapshot | null,
    primaryFailure: string
  ): Promise<void> {
    try {
      if (!priorIdentity || !snapshot) {
        await bridge.audioClose();
        return;
      }
      const restoredIdentity = await bridge.audioOpen(priorIdentity.canonicalPath);
      if (!sameAudioIdentity(restoredIdentity, priorIdentity)) {
        throw new Error('the prior audio identity changed while reopening');
      }
      await bridge.audioSetVolume(snapshot.volume);
      if (snapshot.loopRange) await bridge.audioSetLoop(snapshot.loopRange);
      else await bridge.audioClearLoop();
      await bridge.audioSeek(snapshot.positionMs);
      if (snapshot.state === 'playing') await bridge.audioPlay();
      else await bridge.audioPause();
      await audioSession.refresh();
    } catch (rollbackError) {
      const combined =
        `${primaryFailure}. Restoring the previous audio failed: ${formatUnknownError(rollbackError)}. Reopen the previous clip before continuing.`
      nativePreservationFailures += 1;
      persistentError = combined;
      throw new NativePreservationError(combined);
    }
  }

  function queueNativeOpen(
    path: string,
    identity: AudioIdentity,
    priorIdentity: AudioIdentity | null,
    generation: number,
    publish: () => void
  ): Promise<AudioIdentity | null> {
    const operation = audioOpenQueue.then(async () => {
      if (!isCurrent(generation)) return null;
      let priorSnapshot: PlaybackSnapshot | null = null;
      if (priorIdentity) {
        await audioSession.refresh();
        priorSnapshot = get(audioSession);
        if (!isCurrent(generation)) return null;
      }
      let openedIdentity: AudioIdentity;
      try {
        openedIdentity = await bridge.audioOpen(path);
      } catch (error) {
        const primaryFailure = `Opening ${basename(path)} failed: ${formatUnknownError(error)}`;
        await restoreNativePlayback(priorIdentity, priorSnapshot, primaryFailure);
        if (!isCurrent(generation)) return null;
        throw error;
      }
      if (!sameAudioIdentity(openedIdentity, identity)) {
        await restoreNativePlayback(
          priorIdentity,
          priorSnapshot,
          'Source audio changed while opening; retry the operation'
        );
        if (!isCurrent(generation)) return null;
        throw new Error('Source audio changed while opening; retry the operation');
      }
      if (!isCurrent(generation)) {
        await restoreNativePlayback(priorIdentity, priorSnapshot, 'The audio transition was superseded');
        return null;
      }
      try {
        await audioSession.refresh();
      } catch (error) {
        const primaryFailure = `Opening ${basename(path)} could not establish playback: ${formatUnknownError(error)}`;
        await restoreNativePlayback(priorIdentity, priorSnapshot, primaryFailure);
        if (!isCurrent(generation)) return null;
        throw error;
      }
      if (!isCurrent(generation)) {
        await restoreNativePlayback(priorIdentity, priorSnapshot, 'The audio transition was superseded');
        return null;
      }
      publish();
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
      if (!cleanupRequested) persistentError = formatUnknownError(error);
    });
    void Promise.resolve().then(() => lifecycle.onCloseRequested(requestClose))
      .then((unlisten) => installDisposer('close', unlisten))
      .catch((error) => { if (!cleanupRequested) persistentError = formatUnknownError(error); });
    return () => {
      operationGeneration += 1;
      disposeListeners();
      if (!closePromise) {
        void bridge.cancelAnalysis().catch(() => undefined);
        void audioSession.close().catch(() => undefined);
      }
    };
  });

  function normalizeRecoveredProject(value: Project, changed: boolean): Project {
    if (value.schemaVersion !== 1) throw new Error('The recovered project schema is not supported');
    const hasInvalidReferences = (draft: AnnotationDraft): boolean => (
      (draft.speakerId !== null && !value.speakers.some((speaker) => speaker.id === draft.speakerId))
      || draft.acousticTagIds.some((id) => !value.acousticTags.some((tag) => tag.id === id))
    );
    for (const annotation of value.annotations) {
      const draft: AnnotationDraft = {
        startMs: annotation.startMs, endMs: annotation.endMs, eventType: annotation.eventType,
        transcription: annotation.transcription, intelligibility: annotation.intelligibility,
        speakerId: annotation.speakerId, overlap: annotation.overlap, confidence: annotation.confidence,
        acousticTagIds: annotation.acousticTagIds, notes: annotation.notes
      };
      if (hasInvalidReferences(draft) || Object.keys(validateDraft(draft, value)).length) {
        throw new Error(`Recovered annotation ${annotation.id} does not fit the ${changed ? 'changed audio duration' : 'audio project'}`);
      }
    }
    if (value.activeAnnotationId && !value.annotations.some((item) => item.id === value.activeAnnotationId)) {
      throw new Error('The recovered active annotation no longer exists');
    }
    if (hasInvalidReferences(value.draft)) {
      throw new Error(`The recovered draft does not fit the ${changed ? 'changed audio duration' : 'audio project'}`);
    }
    const draftStarted = value.draft.endMs !== 0 || value.draft.startMs !== 0
      || value.draft.transcription !== '' || value.draft.notes !== '' || value.activeSelection !== null;
    if (!draftStarted) return value;
    const draftErrors = validateDraft(value.draft, value);
    if (draftErrors.transcription === 'Transcription is required for intelligible speech'
      && !value.draft.transcription.includes('\t')) {
      delete draftErrors.transcription;
    }
    if (Object.keys(draftErrors).length) {
      throw new Error(`The recovered draft does not fit the ${changed ? 'changed audio duration' : 'audio project'}`);
    }
    return {
      ...value,
      activeSelection: { startMs: value.draft.startMs, endMs: value.draft.endMs }
    };
  }

  async function openAudio(): Promise<void> {
    if (closePromise) return;
    const request = ++pickerRequest;
    let path: string | null;
    try {
      path = await pickers.audio();
    } catch (error) {
      if (request >= latestStartedPicker) persistentError = formatUnknownError(error);
      return;
    }
    if (!path) return;
    if (closePromise) return;
    if (request < latestStartedPicker) return;
    if (!/\.(mp3|wav)$/i.test(path)) {
      persistentError = 'Choose a single MP3 or WAV audio file';
      return;
    }

    latestStartedPicker = request;
    const generation = ++operationGeneration;
    let transitionStarted = false;
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
      const nextProject = normalizeRecoveredProject(
        restored ? { ...restored, audioIdentity: identity } : createProject(identity),
        changed
      );
      analysisProgress = { processedMs: 0, durationMs: identity.durationMs };
      const nextPeaks = await bridge.analyzeAudio(path);
      if (!isCurrent(generation)) return;
      validatePeaks(nextPeaks, identity);
      beginTransition(generation);
      transitionStarted = true;
      if (get(projectStore).project && !await projectStore.flush()) {
        throw new Error(get(projectStore).saveError ?? 'The current project could not be saved');
      }
      if (!isCurrent(generation)) return;
      const priorProject = get(projectStore).project;
      const projectToPublish = normalizeRecoveredProject(priorProject?.audioIdentity.canonicalPath === identity.canonicalPath
        ? { ...priorProject, audioIdentity: identity }
        : nextProject, changed);
      const openedIdentity = await queueNativeOpen(
        path,
        identity,
        priorProject?.audioIdentity ?? null,
        generation,
        () => {
          projectStore.open(projectToPublish);
          peaks = nextPeaks;
        }
      );
      if (!openedIdentity) return;
      if (!isCurrent(generation)) return;
      audioSession.startPolling();
      status = `Opened ${basename(path)}`;
    } catch (error) {
      if (error instanceof NativePreservationError || isCurrent(generation)) persistentError = formatUnknownError(error);
    } finally {
      if (activeAnalysisGeneration === generation) activeAnalysisGeneration = null;
      if (isCurrent(generation)) analysisProgress = null;
      if (transitionStarted) endTransition(generation);
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
      persistentError = formatUnknownError(error);
    }
  }

  async function importTsv(): Promise<void> {
    if (transitionBusy || closePromise) return;
    try {
      if (!await waitForMultilinePolicy()) return;
      if (transitionBusy || closePromise || !get(projectStore).project) return;
      const path = await pickers.tsv();
      if (!path) return;
      if (!await waitForMultilinePolicy()) return;
      if (transitionBusy || closePromise) return;
      const current = get(projectStore).project;
      if (!current) return;
      const imported = await bridge.readTsv(path, current.exportSettings.multilinePolicy);
      if (transitionBusy || closePromise) return;
      const succeeded = await projectStore.mutateProject((value) => mergeImportedTsv(value, imported, id, now()));
      if (!succeeded) {
        persistentError = get(projectStore).saveError ?? 'The TSV import could not be saved';
        return;
      }
      status = `Imported ${imported.annotations.length} annotation${imported.annotations.length === 1 ? '' : 's'}`;
    } catch (error) {
      persistentError = formatUnknownError(error);
    }
  }

  async function exportTsv(): Promise<void> {
    if (transitionBusy || closePromise) return;
    try {
      if (!await waitForMultilinePolicy()) return;
      if (transitionBusy || closePromise) return;
      let current = get(projectStore).project;
      if (!current) return;
      const defaultPath = `${basename(current.audioIdentity.canonicalPath).replace(/\.[^.]+$/, '')}.tsv`;
      const path = await pickers.exportTsv(defaultPath);
      if (!path) return;
      if (!await waitForMultilinePolicy()) return;
      if (transitionBusy || closePromise) return;
      current = get(projectStore).project;
      if (!current) return;
      await bridge.writeTsv(path, current);
      status = `Exported ${current.annotations.length} annotation${current.annotations.length === 1 ? '' : 's'}`;
    } catch (error) {
      persistentError = formatUnknownError(error);
    }
  }

  async function toggleFormat(): Promise<void> {
    if (transitionBusy || closePromise) return;
    const succeeded = await projectStore.mutateProject((value) => ({
      ...value,
      displayFormat: value.displayFormat === 'seconds' ? 'clock' : 'seconds'
    }));
    if (!succeeded) persistentError = get(projectStore).saveError ?? 'The display setting could not be saved';
  }

  async function setMultilinePolicy(multilinePolicy: MultilinePolicy): Promise<void> {
    if (transitionBusy || closePromise || multilinePolicyMutation) return;
    const request = projectStore.mutateProject((value) => ({
      ...value,
      exportSettings: { ...value.exportSettings, multilinePolicy }
    }));
    multilinePolicyMutation = request;
    settingsBusy = true;
    try {
      const succeeded = await request;
      if (!succeeded) persistentError = get(projectStore).saveError ?? 'The multiline export setting could not be saved';
    } finally {
      if (multilinePolicyMutation === request) {
        multilinePolicyMutation = null;
        settingsBusy = false;
      }
    }
  }

  async function waitForMultilinePolicy(): Promise<boolean> {
    const pending = multilinePolicyMutation;
    return pending ? pending : true;
  }

  function setSelection(selection: Selection): void {
    if (transitionBusy || closePromise) return;
    const current = get(projectStore).project;
    if (!current || current.audioIdentity.durationMs < 1) return;
    const startMs = Math.min(current.audioIdentity.durationMs - 1, Math.max(0, Math.round(selection.startMs)));
    const endMs = Math.min(current.audioIdentity.durationMs, Math.max(startMs + 1, Math.round(selection.endMs)));
    projectStore.setSelection({ startMs, endMs });
  }

  function reportPromise(request: Promise<unknown>): Promise<void> {
    return request.then(() => undefined).catch((error) => { persistentError = formatUnknownError(error); });
  }

  function togglePlay(): void {
    if (transitionBusy || closePromise) return;
    void reportPromise(playback.state === 'playing' ? audioSession.pause() : audioSession.play());
  }

  function toggleLoop(): void {
    if (transitionBusy || closePromise) return;
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
    if (transitionBusy || closePromise) return;
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
    event.preventDefault();
    if (closePromise) return closePromise;
    const attempt = shutdown();
    const shared = attempt.then(() => undefined);
    closePromise = shared;
    void attempt.then((completed) => {
      if (!completed && closePromise === shared) closePromise = null;
    });
    return shared;
  }

  async function shutdown(): Promise<boolean> {
    const shutdownGeneration = ++operationGeneration;
    beginTransition(shutdownGeneration);
    let completed = false;
    const hadAnalysis = activeAnalysisGeneration !== null;
    activeAnalysisGeneration = null;
    analysisProgress = null;
    if (hadAnalysis) {
      try { await bridge.cancelAnalysis(); } catch (error) { persistentError = formatUnknownError(error); }
    }
    try {
      let flushed = false;
      const preservationFailuresBeforeDrain = nativePreservationFailures;
      try { flushed = await projectStore.flush(); } catch (error) { persistentError = formatUnknownError(error); }
      await audioOpenQueue;
      if (!flushed) {
        if (nativePreservationFailures === preservationFailuresBeforeDrain) {
          persistentError = get(projectStore).saveError ?? 'The current project could not be saved before closing';
        }
        return false;
      }
      try { await audioSession.close(); } catch (error) { persistentError = formatUnknownError(error); }
      disposeListeners();
      try { await lifecycle.destroy(); } catch (error) { persistentError = formatUnknownError(error); }
      completed = true;
      return true;
    } finally {
      if (!completed) endTransition(shutdownGeneration);
    }
  }

  const toolbarActions = {
    open: () => void openAudio(),
    importTsv: () => void importTsv(),
    togglePlay,
    toggleLoop,
    toggleFormat: () => void toggleFormat(),
    setMultilinePolicy: (value: MultilinePolicy) => void setMultilinePolicy(value),
    exportTsv: () => void exportTsv(),
    cancelAnalysis: () => void cancelAnalysis(),
    setVolume: (value: number) => {
      if (!transitionBusy && !closePromise) void reportPromise(audioSession.setVolume(value));
    }
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
    multilinePolicy={project?.exportSettings.multilinePolicy ?? 'escape'}
    volume={playback.volume}
    {analysisPercent}
    busy={transitionBusy}
    {settingsBusy}
    actions={toolbarActions}
  />
  <div class="app-status" role="status" aria-label="Operation status" aria-live="polite">{status}</div>
  {#if project}
    <div class="project-workspace" aria-busy={transitionBusy} inert={transitionBusy}>
    <TimelineWorkspace
      durationMs={project.audioIdentity.durationMs}
      format={project.displayFormat}
      selection={project.activeSelection}
      onchange={setSelection}
      {peaks}
      playheadMs={playback.positionMs}
      disabled={transitionBusy}
    />
    <AnnotationDashboard store={projectStore} disabled={transitionBusy} />
    <AnnotationTable
      annotations={tableAnnotations}
      activeId={project.activeAnnotationId}
      disabled={transitionBusy}
      onselect={(annotationId) => { if (!transitionBusy) projectStore.selectAnnotation(annotationId); }}
      onremove={(annotationId) => { if (!transitionBusy) void projectStore.removeAnnotation(annotationId); }}
    />
    </div>
  {:else}
    <section class="empty-state">
      <p>Open an MP3 or WAV file to begin.</p>
    </section>
  {/if}
</main>
