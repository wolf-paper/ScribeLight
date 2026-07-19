import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AudioIdentity, MultilinePolicy, Project } from '../domain/types';

export interface PeakData {
  durationMs: number;
  sampleRate: number;
  framesPerPeak: number;
  channels: number[][];
}

export interface AnalysisProgress {
  processedMs: number;
  durationMs: number;
}

export interface ImportedAnnotation {
  startMs: number;
  endMs: number;
  eventType: 'speech' | 'non_speech';
  transcription: string;
  intelligibility: 'intelligible' | 'partially_intelligible' | 'unintelligible' | 'not_applicable';
  speaker: string | null;
  overlap: 'none' | 'overlap';
  confidence: 'high' | 'medium' | 'low';
  acousticTags: string[];
  notes: string;
}

export interface ImportedTsv {
  annotations: ImportedAnnotation[];
  speakers: string[];
  acousticTags: string[];
}

export interface NativeBridge {
  saveProject(project: Project): Promise<void>;
  loadProject(canonicalAudioPath: string): Promise<Project | null>;
  readTsv(path: string, multilinePolicy: MultilinePolicy): Promise<ImportedTsv>;
  writeTsv(path: string, project: Project): Promise<void>;
  inspectAudio(path: string): Promise<AudioIdentity>;
  analyzeAudio(path: string): Promise<PeakData>;
  cancelAnalysis(): Promise<void>;
  onAnalysisProgress(handler: (progress: AnalysisProgress) => void): Promise<() => void>;
}

export const tauriBridge: NativeBridge = {
  saveProject: (project) => invoke('save_project', { project }),
  loadProject: (canonicalAudioPath) => invoke('load_project', { canonicalAudioPath }),
  readTsv: (path, multilinePolicy) => invoke('read_tsv', { path, multilinePolicy }),
  writeTsv: (path, project) => invoke('write_tsv', { path, project }),
  inspectAudio: (path) => invoke('inspect_audio', { path }),
  analyzeAudio: (path) => invoke('analyze_audio', { path }),
  cancelAnalysis: () => invoke('cancel_analysis'),
  onAnalysisProgress: async (handler) =>
    listen<AnalysisProgress>('analysis-progress', (event) => handler(event.payload))
};
