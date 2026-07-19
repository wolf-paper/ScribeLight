import type {
  ImportedTsv,
  NativeBridge,
  PeakData,
  PlaybackSnapshot
} from '../lib/bridge/native';
import type { Project } from '../lib/domain/types';

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
      intelligibility: 'highly_intelligible',
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
      intelligibility: 'highly_intelligible',
      speaker: 'speaker_2',
      overlap: 'overlap',
      confidence: 'medium',
      acousticTags: ['breath'],
      notes: ''
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      startMs: 3_000 + index * 700,
      endMs: 3_400 + index * 700,
      eventType: 'speech' as const,
      transcription: `Scroll seed ${index + 1}`,
      intelligibility: 'highly_intelligible' as const,
      speaker: index % 2 === 0 ? 'speaker_1' : 'speaker_2',
      overlap: 'none' as const,
      confidence: 'high' as const,
      acousticTags: [],
      notes: ''
    }))
  ]
};

interface BrowserFakeState {
  saved: Project | null;
  snapshot: PlaybackSnapshot;
  nextId: number;
}

interface BrowserExportRecord {
  path: string;
  project: Project;
}

type NativeCall =
  | { command: 'set_loop'; selection: { startMs: number; endMs: number } }
  | { command: 'clear_loop' };

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
  const browserGlobal = globalThis as typeof globalThis & {
    __LIGHTSCRIBE_LAST_EXPORT__: BrowserExportRecord | null;
  };
  const nativeCalls: NativeCall[] = [];
  browserGlobal.__LIGHTSCRIBE_LAST_EXPORT__ = null;
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
    writeTsv: async (path, project) => {
      browserGlobal.__LIGHTSCRIBE_LAST_EXPORT__ = {
        path,
        project: structuredClone(project)
      };
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
    audioSetLoop: async (loopRange) => {
      nativeCalls.push({ command: 'set_loop', selection: { ...loopRange } });
      updateSnapshot({ loopRange: { ...loopRange } });
    },
    audioClearLoop: async () => {
      nativeCalls.push({ command: 'clear_loop' });
      updateSnapshot({ loopRange: null });
    },
    audioSetVolume: async (volume) => updateSnapshot({ volume }),
    audioSnapshot: async () => structuredClone(state.snapshot),
    audioClose: async () => updateSnapshot({ ...emptySnapshot(), volume: state.snapshot.volume })
  };

  const testApi = {
    marker,
    get savedProject() { return state.saved ? structuredClone(state.saved) : null; },
    get snapshot() { return structuredClone(state.snapshot); },
    get nativeCalls() { return structuredClone(nativeCalls); }
  };
  (globalThis as typeof globalThis & { __LIGHTSCRIBE_TEST__: typeof testApi }).__LIGHTSCRIBE_TEST__ = testApi;

  return {
    bridge,
    lifecycle: {
      onCloseRequested: async () => () => undefined,
      destroy: async () => undefined
    },
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
