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
  import AnnotationEditor from './lib/components/AnnotationEditor.svelte';
  import AnnotationList, { type AnnotationRow } from './lib/components/AnnotationList.svelte';
  import ErrorBanner from './lib/components/ErrorBanner.svelte';
  import SettingsDialog from './lib/components/SettingsDialog.svelte';
  import ShortcutHelp from './lib/components/ShortcutHelp.svelte';
  import TimelineWorkspace from './lib/components/TimelineWorkspace.svelte';
  import TopBar from './lib/components/TopBar.svelte';
  import TransportBar from './lib/components/TransportBar.svelte';
  import { mergeImportedTsv } from './lib/domain/importTsv';
  import { createProject } from './lib/domain/project';
  import { formatTime } from './lib/domain/time';
  import type { Annotation, AnnotationDraft, AudioIdentity, Project, Selection } from './lib/domain/types';
  import { normalizeIntelligibility, validateDraft, worksheetErrors } from './lib/domain/validation';
  import { formatUnknownError } from './lib/errors';
  import { AudioSession } from './lib/state/audioSession';
  import { ProjectStore } from './lib/state/projectStore';
  import { getBrowserStorage, loadPalette, persistPalette, type PaletteId } from './lib/theme/palette';

  interface PickerSet {
    audio(): Promise<string | null>;
    tsv(): Promise<string | null>;
    exportTsv(defaultPath?: string): Promise<string | null>;
  }

  interface Props {
    bridge?: NativeBridge;
    pickers?: PickerSet;
    lifecycle?: LifecycleAdapter;
    confirm?: (message: string) => boolean | Promise<boolean>;
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
    confirm = (message) => window.confirm(message),
    id = () => crypto.randomUUID(),
    now = () => new Date().toISOString()
  }: Props = $props();

  const projectStore = new ProjectStore({ saveProject: (value) => bridge.saveProject(value) }, () => id(), () => now());
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
  let nativeTransitionEpoch = 0;
  let transitionBusy = $state(false);
  let tablePreviewAnnotationId = $state<string | null>(null);
  let waveformPreviewAnnotationId = $state<string | null>(null);
  let previewAnnotationId = $state<string | null>(null);
  let editorHandle = $state<AnnotationEditor | null>(null);
  let settingsOpen = $state(false);
  let shortcutsOpen = $state(false);
  let reveal = $state<{ startMs: number; endMs: number; key: number } | null>(null);
  let undoable = $state<Annotation | null>(null);
  let palette = $state<PaletteId>(loadPalette(getBrowserStorage()));
  let closePromise: Promise<void> | null = null;
  let cleanupRequested = false;
  let analysisUnlisten: (() => void) | null = null;
  let closeUnlisten: (() => void) | null = null;
  let windowListenerInstalled = false;
  let lastLoopSelection = '';
  let pendingOwnedLoopSelection = $state('');
  let loopCommandGeneration = 0;
  let lastSaveError: string | null = null;
  let lastPlaybackError: string | null = null;
  let nativePreservationFailures = 0;
  let playbackStart: Promise<void> | null = null;

  class NativePreservationError extends Error {}

  let project = $derived($projectStore.project);
  let playback = $derived($audioSession);
  let orderedAnnotations = $derived(project
    ? [...project.annotations].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    : []);
  let annotationRows = $derived.by((): AnnotationRow[] => project ? orderedAnnotations.map((annotation) => ({
    id: annotation.id,
    startMs: annotation.startMs,
    endMs: annotation.endMs,
    speakerId: annotation.speakerId,
    transcription: annotation.transcription,
    speaker: project.speakers.find((speaker) => speaker.id === annotation.speakerId)?.label
      ?? (annotation.eventType === 'speech' ? 'Not set' : 'Non-speech'),
    tags: annotation.acousticTagIds.flatMap((tagId) => {
      const tag = project.acousticTags.find((candidate) => candidate.id === tagId);
      return tag ? [{ id: tag.id, label: tag.label }] : [];
    }),
    intelligibility: annotation.intelligibility,
    problems: Object.values(worksheetErrors(annotation, project)).filter((message): message is string => Boolean(message))
  })) : []);
  let waveformAnnotations = $derived(annotationRows.map(({ id, startMs, endMs, speaker, speakerId }) => ({
    id, startMs, endMs, label: speakerId ? speaker : ''
  })));
  let activeNumber = $derived.by(() => {
    const index = orderedAnnotations.findIndex((annotation) => annotation.id === project?.activeAnnotationId);
    return index < 0 ? null : index + 1;
  });
  let filename = $derived(project ? basename(project.audioIdentity.canonicalPath) : null);
  let analysisPercent = $derived.by(() => {
    if (!analysisProgress) return null;
    if (!Number.isFinite(analysisProgress.durationMs) || analysisProgress.durationMs <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round(analysisProgress.processedMs / analysisProgress.durationMs * 100)));
  });
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
    previewAnnotationId = waveformPreviewAnnotationId ?? tablePreviewAnnotationId;
  });

  $effect(() => {
    if (transitionBusy) {
      tablePreviewAnnotationId = null;
      waveformPreviewAnnotationId = null;
      return;
    }
    if (tablePreviewAnnotationId !== null
      && !project?.annotations.some(({ id }) => id === tablePreviewAnnotationId)) {
      tablePreviewAnnotationId = null;
    }
    if (waveformPreviewAnnotationId !== null
      && !project?.annotations.some(({ id }) => id === waveformPreviewAnnotationId)) {
      waveformPreviewAnnotationId = null;
    }
  });

  $effect(() => {
    if (transitionBusy) return;
    const selection = project?.activeSelection ?? null;
    const loopEnabled = playback.loopRange !== null;
    if (!selection) {
      const currentLoopKey = playback.loopRange
        ? `${playback.loopRange.startMs}:${playback.loopRange.endMs}`
        : '';
      const observedOwnedLoopKey = lastLoopSelection;
      const pendingOwnedLoopKey = pendingOwnedLoopSelection;
      lastLoopSelection = '';
      if (pendingOwnedLoopKey !== '') {
        if (currentLoopKey === '' || currentLoopKey === pendingOwnedLoopKey) queueLoopCommand(null);
        else if (playback.loopRange) queueLoopCommand(playback.loopRange, false);
      } else if (currentLoopKey !== '' && currentLoopKey === observedOwnedLoopKey) {
        queueLoopCommand(null);
      }
      return;
    }
    if (!loopEnabled) {
      lastLoopSelection = '';
      return;
    }
    const key = `${selection.startMs}:${selection.endMs}`;
    if (key === lastLoopSelection) return;
    lastLoopSelection = key;
    queueLoopCommand(selection);
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
      && Math.floor(value.totalFrames * 1_000 / identity.sampleRate) === identity.durationMs
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
    nativeTransitionEpoch += 1;
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
      window.removeEventListener('keyup', globalKeyup);
      windowListenerInstalled = false;
    }
  }

  onMount(() => {
    window.addEventListener('keydown', globalKeydown);
    window.addEventListener('keyup', globalKeyup);
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
    value = {
      ...value,
      annotations: value.annotations.map((annotation) => ({
        ...annotation,
        intelligibility: normalizeIntelligibility(annotation.intelligibility)
      })),
      draft: {
        ...value.draft,
        intelligibility: normalizeIntelligibility(value.draft.intelligibility)
      }
    };
    const usedIds = new Set<string>();
    for (const identified of [...value.speakers, ...value.acousticTags, ...value.annotations]) {
      if (typeof identified.id !== 'string' || !identified.id.trim() || usedIds.has(identified.id)) {
        throw new Error('Recovered speakers, acoustic tags, and annotations require a unique nonempty project ID');
      }
      usedIds.add(identified.id);
    }
    const normalizeLabels = (
      definitions: Project['speakers'],
      kind: 'speaker' | 'acoustic tag'
    ): Project['speakers'] => {
      const labels = new Set<string>();
      return definitions.map((definition) => {
        if (typeof definition.label !== 'string') {
          throw new Error(`Recovered ${kind} labels are invalid`);
        }
        const label = definition.label.trim();
        if (!label || label === 'none' || label.includes('\t')
          || (kind === 'acoustic tag' && label.includes(';')) || labels.has(label)) {
          throw new Error(`Recovered ${kind} labels are invalid`);
        }
        labels.add(label);
        return label === definition.label ? definition : { ...definition, label };
      });
    };
    value = {
      ...value,
      speakers: normalizeLabels(value.speakers, 'speaker'),
      acousticTags: normalizeLabels(value.acousticTags, 'acoustic tag')
    };
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
    if (value.activeAnnotationId !== null
      && !value.annotations.some((item) => item.id === value.activeAnnotationId)) {
      throw new Error('The recovered active annotation no longer exists');
    }
    if (hasInvalidReferences(value.draft)) {
      throw new Error(`The recovered draft does not fit the ${changed ? 'changed audio duration' : 'audio project'}`);
    }
    const draftStarted = value.draft.endMs !== 0 || value.draft.startMs !== 0
      || value.draft.transcription !== '' || value.draft.notes !== '' || value.activeSelection !== null;
    if (!draftStarted) return value;
    const draftErrors = validateDraft(value.draft, value);
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
      if (changed && !await confirm('The source audio changed. Reuse its existing annotations and regenerate the waveform?')) return;
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
          undoable = null;
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

  function reviewCount(value: Project): number {
    return value.annotations.filter((annotation) => Object.keys(worksheetErrors(annotation, value)).length).length;
  }

  function reviewStatus(): string {
    const current = get(projectStore).project;
    const count = current ? reviewCount(current) : 0;
    return count ? `; ${count} need${count === 1 ? 's' : ''} review for Yamabiko` : '';
  }

  async function importTsv(): Promise<void> {
    if (transitionBusy || closePromise) return;
    try {
      if (!get(projectStore).project) return;
      const path = await pickers.tsv();
      if (!path) return;
      if (transitionBusy || closePromise || !get(projectStore).project) return;
      const imported = await bridge.readTsv(path);
      if (transitionBusy || closePromise) return;
      const succeeded = await projectStore.mutateProject((value) => mergeImportedTsv(value, imported, id, now()));
      if (!succeeded) {
        persistentError = get(projectStore).saveError ?? 'The TSV import could not be saved';
        return;
      }
      status = `Imported ${imported.annotations.length} annotation${imported.annotations.length === 1 ? '' : 's'}${reviewStatus()}`;
    } catch (error) {
      persistentError = formatUnknownError(error);
    }
  }

  async function exportTsv(): Promise<void> {
    if (transitionBusy || closePromise) return;
    try {
      let current = get(projectStore).project;
      if (!current) return;
      const pending = reviewCount(current);
      if (pending && !await confirm(
        `${pending} annotation${pending === 1 ? '' : 's'} still need${pending === 1 ? 's' : ''} review, so Yamabiko will reject this file. Export anyway?`
      )) return;
      const defaultPath = `${basename(current.audioIdentity.canonicalPath).replace(/\.[^.]+$/, '')}.tsv`;
      const path = await pickers.exportTsv(defaultPath);
      if (!path) return;
      if (transitionBusy || closePromise) return;
      current = get(projectStore).project;
      if (!current) return;
      await bridge.writeTsv(path, current);
      status = `Exported ${current.annotations.length} annotation${current.annotations.length === 1 ? '' : 's'}${reviewStatus()}`;
    } catch (error) {
      persistentError = formatUnknownError(error);
    }
  }

  function changePalette(value: PaletteId): void {
    palette = value;
    persistPalette(value);
  }

  function clampSelection(selection: Selection, durationMs: number): Selection {
    const startMs = Math.min(durationMs - 1, Math.max(0, Math.round(selection.startMs)));
    return { startMs, endMs: Math.min(durationMs, Math.max(startMs + 1, Math.round(selection.endMs))) };
  }

  /** Adjusts the range of whatever is open in the editor (autosaved for a saved annotation). */
  function setSelection(selection: Selection): void {
    if (transitionBusy || closePromise) return;
    const current = get(projectStore).project;
    if (!current || current.audioIdentity.durationMs < 1) return;
    projectStore.setSelection(clampSelection(selection, current.audioIdentity.durationMs));
  }

  /** A range dragged out on the waveform starts a new, unsaved annotation. */
  function createSelection(selection: Selection): void {
    if (transitionBusy || closePromise) return;
    const current = get(projectStore).project;
    if (!current || current.audioIdentity.durationMs < 1) return;
    const range = clampSelection(selection, current.audioIdentity.durationMs);
    projectStore.beginDraft(range);
    seekTo(range.startMs);
  }

  function seekTo(milliseconds: number): void {
    if (transitionBusy || closePromise) return;
    const current = get(projectStore).project;
    if (!current) return;
    void reportPromise(audioSession.seek(Math.min(current.audioIdentity.durationMs, Math.max(0, Math.round(milliseconds)))));
  }

  function revealRange(range: Selection): void {
    reveal = { startMs: range.startMs, endMs: range.endMs, key: (reveal?.key ?? 0) + 1 };
  }

  function activateAnnotation(annotationId: string): void {
    if (transitionBusy || closePromise) return;
    const annotation = get(projectStore).project?.annotations.find((item) => item.id === annotationId);
    if (!annotation) return;
    projectStore.selectAnnotation(annotationId);
    revealRange(annotation);
    seekTo(annotation.startMs);
  }

  function stepAnnotation(step: 1 | -1): void {
    const current = get(projectStore).project;
    if (!current || !orderedAnnotations.length) return;
    const index = orderedAnnotations.findIndex((annotation) => annotation.id === current.activeAnnotationId);
    const position = get(audioSession).positionMs;
    const next = index >= 0
      ? orderedAnnotations[index + step]
      : step > 0
        ? orderedAnnotations.find((annotation) => annotation.startMs >= position)
        : orderedAnnotations.filter((annotation) => annotation.startMs < position).at(-1);
    if (next) activateAnnotation(next.id);
  }

  function stepReview(direction: 1 | -1): void {
    const current = get(projectStore).project;
    if (!current) return;
    const flagged = annotationRows.filter((row) => row.problems.length);
    if (!flagged.length) {
      status = 'Every annotation is ready for Yamabiko';
      return;
    }
    const index = annotationRows.findIndex((row) => row.id === current.activeAnnotationId);
    const position = get(audioSession).positionMs;
    const after = index >= 0 ? annotationRows.slice(index + 1) : annotationRows.filter((row) => row.startMs >= position);
    const before = index >= 0 ? annotationRows.slice(0, index) : annotationRows.filter((row) => row.startMs < position);
    const target = direction > 0
      ? after.find((row) => row.problems.length) ?? flagged[0]
      : before.filter((row) => row.problems.length).at(-1) ?? flagged.at(-1);
    if (target) activateAnnotation(target.id);
  }

  function setBoundaryAtPlayhead(kind: 'start' | 'end'): void {
    if (transitionBusy || closePromise) return;
    const current = get(projectStore).project;
    if (!current || current.audioIdentity.durationMs < 1) return;
    const position = Math.min(current.audioIdentity.durationMs, Math.max(0, get(audioSession).positionMs));
    const range = current.activeSelection;
    if (kind === 'start') {
      const startMs = Math.min(current.audioIdentity.durationMs - 1, position);
      const endMs = range && range.endMs > startMs ? range.endMs : Math.min(current.audioIdentity.durationMs, startMs + 1_000);
      setSelection({ startMs, endMs });
    } else if (range && position > range.startMs) {
      setSelection({ ...range, endMs: position });
    } else {
      status = 'Set the start first (I), then the end (O) after it';
    }
  }

  function playRange(): void {
    const range = get(projectStore).project?.activeSelection;
    if (range && !transitionBusy && !closePromise) void reportPromise(startPlayback(range.startMs));
  }

  async function deleteAnnotation(annotationId: string): Promise<void> {
    if (transitionBusy || closePromise) return;
    const removed = await projectStore.removeAnnotation(annotationId);
    if (!removed) {
      persistentError = get(projectStore).saveError ?? 'The annotation could not be deleted';
      return;
    }
    undoable = removed;
    status = `Deleted the annotation at ${formatTime(removed.startMs)}`;
  }

  async function undoDelete(): Promise<void> {
    const annotation = undoable;
    if (!annotation || transitionBusy || closePromise) return;
    undoable = null;
    if (!await projectStore.restoreAnnotation(annotation)) {
      persistentError = get(projectStore).saveError ?? 'The annotation could not be restored';
      return;
    }
    status = `Restored the annotation at ${formatTime(annotation.startMs)}`;
    activateAnnotation(annotation.id);
  }

  function previewWaveformAnnotation(annotationId: string, previewing: boolean): void {
    if (transitionBusy) return;
    if (previewing) waveformPreviewAnnotationId = annotationId;
    else if (waveformPreviewAnnotationId === annotationId) waveformPreviewAnnotationId = null;
  }

  function reportPromise(request: Promise<unknown>): Promise<void> {
    return request.then(() => undefined).catch((error) => { persistentError = formatUnknownError(error); });
  }

  function queueLoopCommand(selection: Selection | null, appOwned = true): void {
    const generation = ++loopCommandGeneration;
    pendingOwnedLoopSelection = appOwned && selection
      ? `${selection.startMs}:${selection.endMs}`
      : '';
    void reportPromise(audioSession.setLoop(selection)).finally(() => {
      if (loopCommandGeneration === generation) pendingOwnedLoopSelection = '';
    });
  }

  /** Plays from the playhead, or from `fromMs` when given (Play range). */
  function startPlayback(fromMs: number | null = null): Promise<void> {
    if (playbackStart) return playbackStart;
    const generation = operationGeneration;
    const transitionEpoch = nativeTransitionEpoch;
    let request: Promise<void>;
    request = (async () => {
      if (fromMs !== null) await audioSession.seek(fromMs);
      const state = get(audioSession).state;
      if (!isCurrent(generation) || transitionEpoch !== nativeTransitionEpoch
        || transitionBusy || closePromise
        || (state !== 'paused' && state !== 'playing')) return;
      if (state !== 'playing') await audioSession.play();
    })().finally(() => {
      if (playbackStart === request) playbackStart = null;
    });
    playbackStart = request;
    return request;
  }

  function togglePlay(): void {
    if (transitionBusy || closePromise) return;
    const snapshot = get(audioSession);
    if (snapshot.state === 'playing') {
      void reportPromise(audioSession.pause());
    } else if (!playbackStart) {
      void reportPromise(startPlayback());
    }
  }

  function toggleLoop(): void {
    if (transitionBusy || closePromise) return;
    let next = playback.loopRange ? null : project?.activeSelection ?? null;
    if (!playback.loopRange && !next && project && canLoop) {
      next = { startMs: project.draft.startMs, endMs: project.draft.endMs };
      setSelection(next);
    }
    lastLoopSelection = next ? `${next.startMs}:${next.endMs}` : '';
    queueLoopCommand(next);
  }

  function isTyping(target: Element | null): boolean {
    return Boolean(target?.closest('input:not([type="range"]), textarea, select, [contenteditable]:not([contenteditable="false"])'));
  }

  function globalKeyup(event: KeyboardEvent): void {
    // Space is play/pause everywhere outside text fields, so it must not also press the focused button.
    if (event.code === 'Space' && !isTyping(event.target instanceof Element ? event.target : null)) event.preventDefault();
  }

  function globalKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.target instanceof Element ? event.target : null;
    if (isTyping(target)) {
      if (event.key === 'Escape' && target instanceof HTMLElement) target.blur();
      return;
    }
    if (settingsOpen || shortcutsOpen) return;
    if (event.key === '?') {
      event.preventDefault();
      shortcutsOpen = true;
      return;
    }
    if (transitionBusy || closePromise) return;
    const current = get(projectStore).project;
    if (!current) return;
    if (event.code === 'Space') {
      event.preventDefault();
      togglePlay();
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === 'z' && undoable) {
        event.preventDefault();
        void undoDelete();
      }
      return;
    }
    if (event.altKey) return;
    const onControl = Boolean(target?.closest('button, a[href], [role="combobox"]'));
    switch (event.key) {
      case 'i': case 'I': setBoundaryAtPlayhead('start'); return;
      case 'o': case 'O': setBoundaryAtPlayhead('end'); return;
      case 'l': case 'L': toggleLoop(); return;
      case 'n': case 'N': stepReview(event.shiftKey ? -1 : 1); return;
      case 'Escape': projectStore.beginDraft(null); return;
      case 'Delete':
        if (current.activeAnnotationId) void deleteAnnotation(current.activeAnnotationId);
        return;
      case 'Enter':
        if (onControl) return;
        event.preventDefault();
        editorHandle?.focusTranscription();
        return;
      case 'ArrowUp': case 'ArrowDown':
        event.preventDefault();
        stepAnnotation(event.key === 'ArrowDown' ? 1 : -1);
        return;
      case 'ArrowLeft': case 'ArrowRight': {
        event.preventDefault();
        const magnitude = event.shiftKey ? 1_000 : 50;
        seekTo(get(audioSession).positionMs + (event.key === 'ArrowLeft' ? -magnitude : magnitude));
      }
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

  function setVolume(value: number): void {
    if (!transitionBusy && !closePromise) void reportPromise(audioSession.setVolume(value));
  }
</script>

<svelte:head><title>ScribeLight</title></svelte:head>

<main class="app-shell">
  <h1 class="visually-hidden">ScribeLight</h1>
  <TopBar
    {filename}
    {analysisPercent}
    busy={transitionBusy}
    onopen={() => void openAudio()}
    onimport={() => void importTsv()}
    onexport={() => void exportTsv()}
    oncancelanalysis={() => void cancelAnalysis()}
    onshortcuts={() => { shortcutsOpen = true; }}
    onsettings={() => { settingsOpen = true; }}
  />
  <ErrorBanner message={persistentError} dismiss={() => persistentError = null} />
  {#if project}
    <div class="workspace" aria-busy={transitionBusy} inert={transitionBusy}>
      <TimelineWorkspace
        durationMs={project.audioIdentity.durationMs}
        selection={project.activeSelection}
        {peaks}
        annotations={waveformAnnotations}
        {previewAnnotationId}
        activeAnnotationId={project.activeAnnotationId}
        playing={playback.state === 'playing'}
        {reveal}
        playheadMs={playback.positionMs}
        disabled={transitionBusy}
        onchange={setSelection}
        oncreate={createSelection}
        onseek={seekTo}
        onannotationpreview={previewWaveformAnnotation}
        onannotationactivate={activateAnnotation}
      />
      <TransportBar
        positionMs={playback.positionMs}
        durationMs={project.audioIdentity.durationMs}
        playing={playback.state === 'playing'}
        loopEnabled={playback.loopRange !== null}
        {canLoop}
        volume={playback.volume}
        disabled={transitionBusy}
        ontoggleplay={togglePlay}
        onskip={(delta) => seekTo(playback.positionMs + delta)}
        ontoggleloop={toggleLoop}
        onvolume={setVolume}
      />
      <div class="work-area">
        <AnnotationList
          annotations={annotationRows}
          activeId={project.activeAnnotationId}
          disabled={transitionBusy}
          onselect={activateAnnotation}
          onpreview={(annotationId) => { if (!transitionBusy) tablePreviewAnnotationId = annotationId; }}
          onreview={stepReview}
        />
        <AnnotationEditor
          bind:this={editorHandle}
          store={projectStore}
          disabled={transitionBusy}
          annotationNumber={activeNumber}
          annotationCount={orderedAnnotations.length}
          onsetboundary={setBoundaryAtPlayhead}
          onplayrange={playRange}
          ondelete={(annotationId) => void deleteAnnotation(annotationId)}
        />
      </div>
    </div>
  {:else}
    <section class="empty-state" aria-label="No clip open">
      <p>Open an MP3 or WAV clip to start annotating.</p>
      <button type="button" class="primary" onclick={() => void openAudio()}>Choose audio file</button>
    </section>
  {/if}
  <footer class="status-bar">
    <p role="status" aria-label="Operation status" aria-live="polite">{status}</p>
    {#if undoable}
      <button type="button" class="ghost" onclick={() => void undoDelete()}>Undo <kbd>Ctrl+Z</kbd></button>
    {/if}
    <button type="button" class="ghost hint" onclick={() => { shortcutsOpen = true; }}>Shortcuts <kbd>?</kbd></button>
  </footer>
  {#if settingsOpen}
    <SettingsDialog
      store={project ? projectStore : null}
      {palette}
      disabled={transitionBusy}
      onpalette={changePalette}
      onclose={() => { settingsOpen = false; }}
    />
  {/if}
  {#if shortcutsOpen}
    <ShortcutHelp onclose={() => { shortcutsOpen = false; }} />
  {/if}
</main>
