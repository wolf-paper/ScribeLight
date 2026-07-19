export type TimeDisplayFormat = 'seconds' | 'clock';
export type EventType = 'speech' | 'non_speech';
export type Intelligibility = 'highly_intelligible' | 'partially_intelligible' | 'unintelligible' | 'not_applicable';
export type Overlap = 'none' | 'overlap';
export type Confidence = 'high' | 'medium' | 'low';
export type MultilinePolicy = 'escape' | 'space' | 'quoted';

export interface Selection { startMs: number; endMs: number }
export interface LabelDefinition { id: string; label: string }
export interface AudioIdentity {
  canonicalPath: string;
  size: number;
  modifiedMs: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
}
export interface Annotation {
  id: string;
  startMs: number;
  endMs: number;
  eventType: EventType;
  transcription: string;
  intelligibility: Intelligibility;
  speakerId: string | null;
  overlap: Overlap;
  confidence: Confidence;
  acousticTagIds: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}
export type AnnotationDraft = Omit<Annotation, 'id' | 'createdAt' | 'updatedAt'>;
export interface ExportSettings { multilinePolicy: MultilinePolicy }
export interface Project {
  schemaVersion: 1;
  audioIdentity: AudioIdentity;
  displayFormat: TimeDisplayFormat;
  speakers: LabelDefinition[];
  acousticTags: LabelDefinition[];
  annotations: Annotation[];
  draft: AnnotationDraft;
  activeAnnotationId: string | null;
  activeSelection: Selection | null;
  exportSettings: ExportSettings;
}
