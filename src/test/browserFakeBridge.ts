import type {
  ImportedTsv,
  NativeBridge,
  PeakData,
  PlaybackSnapshot
} from '../lib/bridge/native';
import type { MultilinePolicy, Project } from '../lib/domain/types';

const marker = 'LIGHTSCRIBE_BROWSER_FAKE_V1';
const identity = {
  canonicalPath: 'annotation-audio-test.wav',
  size: 960_044,
  modifiedMs: 1,
  durationMs: 10_000,
  sampleRate: 48_000,
  channels: 1
} as const;
const importedFixture: ImportedTsv = {
  speakers: ['speaker_1', 'speaker_2'],
  acousticTags: ['quiet_dialogue', 'breath'],
  annotations: [
    {
      startMs: 1_000,
      endMs: 2_000,
      eventType: 'speech',
      transcription: '待って',
      intelligibility: 'intelligible',
      speaker: 'speaker_1',
      overlap: 'overlap',
      confidence: 'high',
      acousticTags: ['quiet_dialogue'],
      notes: ''
    },
    {
      startMs: 1_500,
      endMs: 2_500,
      eventType: 'speech',
      transcription: 'はい',
      intelligibility: 'intelligible',
      speaker: 'speaker_2',
      overlap: 'overlap',
      confidence: 'medium',
      acousticTags: ['breath'],
      notes: ''
    }
  ]
};

interface BrowserFakeState {
  saved: Project | null;
  snapshot: PlaybackSnapshot;
  lastTsv: string;
  nextId: number;
}

const emptySnapshot = (): PlaybackSnapshot => ({
  state: 'empty',
  positionMs: 0,
  durationMs: 0,
  loopRange: null,
  volume: 1,
  underruns: 0
});

const freshState = (): BrowserFakeState => ({
  saved: null,
  snapshot: emptySnapshot(),
  lastTsv: '',
  nextId: 0
});

function storageKey(): string {
  const story = new URLSearchParams(location.search).get('case') ?? 'default';
  return `lightscribe:e2e:${story}`;
}

function readState(key: string): BrowserFakeState {
  if (new URLSearchParams(location.search).get('reset') === '1') sessionStorage.removeItem(key);
  const stored = sessionStorage.getItem(key);
  if (!stored) return freshState();
  try {
    return JSON.parse(stored) as BrowserFakeState;
  } catch {
    sessionStorage.removeItem(key);
    return freshState();
  }
}

function encodeMultiline(value: string, policy: MultilinePolicy): string {
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (policy === 'escape') return normalized.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
  if (policy === 'space') return normalized.replaceAll('\n', ' ');
  return normalized;
}

function cell(value: string): string {
  return /[\t\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function portableTsv(project: Project): string {
  const header = 'start_seconds\tend_seconds\tevent_type\ttranscription\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\tnotes\n';
  const speaker = (id: string | null) =>
    project.speakers.find((item) => item.id === id)?.label ?? 'none';
  const tags = (ids: string[]) => ids
    .map((id) => project.acousticTags.find((item) => item.id === id)?.label)
    .filter((label): label is string => Boolean(label))
    .join(';');
  const rows = [...project.annotations]
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    .map((annotation) => [
      (annotation.startMs / 1_000).toFixed(3),
      (annotation.endMs / 1_000).toFixed(3),
      annotation.eventType,
      encodeMultiline(annotation.transcription, project.exportSettings.multilinePolicy),
      annotation.intelligibility,
      speaker(annotation.speakerId),
      annotation.overlap,
      annotation.confidence,
      tags(annotation.acousticTagIds),
      encodeMultiline(annotation.notes, project.exportSettings.multilinePolicy)
    ].map(cell).join('\t'))
    .join('\n');
  return header + rows + (rows ? '\n' : '');
}

function fixedPeaks(): PeakData {
  return {
    totalFrames: 480_000,
    durationMs: 10_000,
    sampleRate: 48_000,
    framesPerPeak: 480,
    channels: [Array.from({ length: 2_000 }, (_, index) => index % 2 === 0 ? -0.1 : 0.1)]
  };
}

export function browserTestProps() {
  const key = storageKey();
  let state = readState(key);
  const persist = () => sessionStorage.setItem(key, JSON.stringify(state));
  const updateSnapshot = (patch: Partial<PlaybackSnapshot>) => {
    state = { ...state, snapshot: { ...state.snapshot, ...patch } };
    persist();
  };

  const bridge: NativeBridge = {
    saveProject: async (project) => {
      state = { ...state, saved: structuredClone(project) };
      persist();
    },
    loadProject: async (canonicalAudioPath) =>
      state.saved?.audioIdentity.canonicalPath === canonicalAudioPath
        ? structuredClone(state.saved)
        : null,
    readTsv: async () => structuredClone(importedFixture),
    writeTsv: async (_path, project) => {
      state = { ...state, lastTsv: portableTsv(project) };
      persist();
    },
    inspectAudio: async () => ({ ...identity }),
    analyzeAudio: async () => fixedPeaks(),
    cancelAnalysis: async () => undefined,
    onAnalysisProgress: async () => () => undefined,
    audioOpen: async () => {
      updateSnapshot({ state: 'paused', positionMs: 0, durationMs: identity.durationMs, loopRange: null });
      return { ...identity };
    },
    audioPlay: async () => updateSnapshot({ state: 'playing' }),
    audioPause: async () => updateSnapshot({ state: 'paused' }),
    audioSeek: async (positionMs) => updateSnapshot({ positionMs }),
    audioSetLoop: async (loopRange) => updateSnapshot({ loopRange: { ...loopRange } }),
    audioClearLoop: async () => updateSnapshot({ loopRange: null }),
    audioSetVolume: async (volume) => updateSnapshot({ volume }),
    audioSnapshot: async () => structuredClone(state.snapshot),
    audioClose: async () => updateSnapshot({ ...emptySnapshot(), volume: state.snapshot.volume })
  };

  const testApi = {
    marker,
    get lastTsv() { return state.lastTsv; },
    get savedProject() { return state.saved ? structuredClone(state.saved) : null; },
    get snapshot() { return structuredClone(state.snapshot); }
  };
  (globalThis as typeof globalThis & { __LIGHTSCRIBE_TEST__: typeof testApi }).__LIGHTSCRIBE_TEST__ = testApi;

  return {
    bridge,
    pickers: {
      audio: async () => new URLSearchParams(location.search).get('fixture'),
      tsv: async () => 'pass-a.annotation.private.tsv',
      exportTsv: async () => 'lightscribe-export.tsv'
    },
    id: () => {
      state = { ...state, nextId: state.nextId + 1 };
      persist();
      return `e2e-${state.nextId}`;
    },
    now: () => '2026-07-18T12:00:00.000Z'
  };
}
