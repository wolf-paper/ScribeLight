import { vi, type Mock } from 'vitest';
import type {
  AnalysisProgress, ImportedTsv, NativeBridge, PeakData, PlaybackSnapshot
} from '../lib/bridge/native';
import type { AudioIdentity, Project } from '../lib/domain/types';

export const fakeIdentity = (canonicalPath = 'clip.wav', durationMs = 1_000): AudioIdentity => ({
  canonicalPath, size: 100, modifiedMs: 200, durationMs, sampleRate: 1_000, channels: 1
});

export const fakePeaks = (durationMs = 1_000): PeakData => ({
  totalFrames: durationMs, durationMs, sampleRate: 1_000, framesPerPeak: 10, channels: [[0, 0.5, -0.5, 0]]
});

type MockNativeBridge = { [Key in keyof NativeBridge]: Mock<NativeBridge[Key]> };

export type FakeBridge = MockNativeBridge & {
  emitProgress(progress: AnalysisProgress): void;
  savedProjects: Project[];
  snapshot: PlaybackSnapshot;
};

export function makeFakeBridge(options: {
  identity?: AudioIdentity;
  restored?: Project | null;
  imported?: ImportedTsv;
  onSave?: (project: Project) => void;
} = {}): FakeBridge {
  const identity = options.identity ?? fakeIdentity();
  const progressHandlers = new Set<(progress: AnalysisProgress) => void>();
  const savedProjects: Project[] = [];
  const bridge: FakeBridge = {
    savedProjects,
    snapshot: {
      state: 'paused', positionMs: 100, durationMs: identity.durationMs,
      loopRange: null, volume: 1, underruns: 0
    },
    saveProject: vi.fn(async (project: Project) => {
      const copy = structuredClone(project);
      savedProjects.push(copy);
      options.onSave?.(copy);
    }),
    loadProject: vi.fn(async () => options.restored ?? null),
    readTsv: vi.fn(async () => options.imported ?? { annotations: [], speakers: [], acousticTags: [] }),
    writeTsv: vi.fn(async () => undefined),
    inspectAudio: vi.fn(async () => identity),
    analyzeAudio: vi.fn(async () => fakePeaks(identity.durationMs)),
    cancelAnalysis: vi.fn(async () => undefined),
    onAnalysisProgress: vi.fn(async (handler: (progress: AnalysisProgress) => void) => {
      progressHandlers.add(handler);
      return vi.fn(() => progressHandlers.delete(handler));
    }),
    audioOpen: vi.fn(async () => identity),
    audioPlay: vi.fn(async () => { bridge.snapshot = { ...bridge.snapshot, state: 'playing' }; }),
    audioPause: vi.fn(async () => { bridge.snapshot = { ...bridge.snapshot, state: 'paused' }; }),
    audioSeek: vi.fn(async (milliseconds: number) => { bridge.snapshot = { ...bridge.snapshot, positionMs: milliseconds }; }),
    audioSetLoop: vi.fn(async (selection) => { bridge.snapshot = { ...bridge.snapshot, loopRange: selection }; }),
    audioClearLoop: vi.fn(async () => { bridge.snapshot = { ...bridge.snapshot, loopRange: null }; }),
    audioSetVolume: vi.fn(async (volume: number) => { bridge.snapshot = { ...bridge.snapshot, volume }; }),
    audioSnapshot: vi.fn(async () => bridge.snapshot),
    audioClose: vi.fn(async () => { bridge.snapshot = { ...bridge.snapshot, state: 'empty', positionMs: 0, durationMs: 0, loopRange: null }; }),
    emitProgress(progress) {
      for (const handler of progressHandlers) handler(progress);
    }
  };
  return bridge;
}

export function makeFakeLifecycle() {
  let closeHandler: ((event: { preventDefault(): void }) => void | Promise<void>) | null = null;
  const closeUnlisten = vi.fn();
  const lifecycle = {
    onCloseRequested: vi.fn(async (handler: typeof closeHandler) => {
      closeHandler = handler;
      return closeUnlisten;
    }),
    destroy: vi.fn(async () => undefined)
  };
  return {
    lifecycle,
    closeUnlisten,
    triggerClose: () => {
      const event = { preventDefault: vi.fn() };
      const result = closeHandler?.(event);
      return { event, result: Promise.resolve(result) };
    }
  };
}

export const nullPickers = {
  audio: async () => null,
  tsv: async () => null,
  exportTsv: async () => null
};
