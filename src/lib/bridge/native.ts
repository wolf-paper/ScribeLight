import { invoke } from '@tauri-apps/api/core';
import type { MultilinePolicy, Project } from '../domain/types';

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
}

export const tauriBridge: NativeBridge = {
  saveProject: (project) => invoke('save_project', { project }),
  loadProject: (canonicalAudioPath) => invoke('load_project', { canonicalAudioPath }),
  readTsv: (path, multilinePolicy) => invoke('read_tsv', { path, multilinePolicy }),
  writeTsv: (path, project) => invoke('write_tsv', { path, project })
};
