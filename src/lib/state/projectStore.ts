import { get, writable, type Readable } from 'svelte/store';
import { emptyDraft } from '../domain/project';
import type { Annotation, AnnotationDraft, Project, Selection } from '../domain/types';
import { validateDraft, type FieldErrors } from '../domain/validation';

interface SaveBridge {
  saveProject(project: Project): Promise<void>;
}

export interface ProjectState {
  project: Project | null;
  errors: FieldErrors;
  saveError: string | null;
}

export class ProjectStore implements Readable<ProjectState> {
  private readonly state = writable<ProjectState>({ project: null, errors: {}, saveError: null });
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private saveInFlight = false;
  readonly subscribe = this.state.subscribe;

  constructor(private readonly bridge: SaveBridge, private readonly id: () => string = () => crypto.randomUUID()) {}

  open(project: Project): void {
    this.cancelRecovery();
    this.state.set({ project, errors: {}, saveError: null });
  }

  patchDraft(patch: Partial<AnnotationDraft>): void {
    this.updateProject((project) => ({ ...project, draft: { ...project.draft, ...patch } }));
    this.scheduleRecovery();
  }

  setSelection(selection: Selection | null): void {
    this.updateProject((project) => ({
      ...project,
      activeSelection: selection,
      draft: selection ? { ...project.draft, ...selection } : project.draft
    }));
    this.scheduleRecovery();
  }

  selectAnnotation(id: string): void {
    this.updateProject((project) => {
      const annotation = project.annotations.find((item) => item.id === id);
      if (!annotation) return project;
      const draft: AnnotationDraft = {
        startMs: annotation.startMs,
        endMs: annotation.endMs,
        eventType: annotation.eventType,
        transcription: annotation.transcription,
        intelligibility: annotation.intelligibility,
        speakerId: annotation.speakerId,
        overlap: annotation.overlap,
        confidence: annotation.confidence,
        acousticTagIds: [...annotation.acousticTagIds],
        notes: annotation.notes
      };
      return {
        ...project,
        activeAnnotationId: id,
        activeSelection: { startMs: annotation.startMs, endMs: annotation.endMs },
        draft
      };
    });
  }

  async removeAnnotation(id: string): Promise<void> {
    const current = get(this.state).project;
    if (!current) return;
    const wasActive = current.activeAnnotationId === id;
    const project: Project = {
      ...current,
      annotations: current.annotations.filter((item) => item.id !== id),
      activeAnnotationId: wasActive ? null : current.activeAnnotationId,
      activeSelection: wasActive ? null : current.activeSelection,
      draft: wasActive ? { ...emptyDraft(), speakerId: current.speakers[0]?.id ?? null } : current.draft
    };
    this.state.set({ project, errors: {}, saveError: null });
    await this.persist(project);
  }

  async flush(): Promise<void> {
    this.cancelRecovery();
    const project = get(this.state).project;
    if (project) await this.persist(project);
  }

  clearDraft(): void {
    this.updateProject((project) => ({
      ...project,
      activeAnnotationId: null,
      activeSelection: null,
      draft: { ...emptyDraft(), speakerId: project.speakers[0]?.id ?? null }
    }));
  }

  async commitDraft(now = new Date().toISOString()): Promise<boolean> {
    const current = get(this.state);
    if (!current.project) return false;
    const errors = validateDraft(current.project.draft, current.project);
    if (Object.keys(errors).length) {
      this.state.update((value) => ({ ...value, errors }));
      return false;
    }
    this.cancelRecovery();
    const active = current.project.annotations.find((item) => item.id === current.project!.activeAnnotationId);
    const annotation: Annotation = {
      ...current.project.draft,
      id: active?.id ?? this.id(),
      createdAt: active?.createdAt ?? now,
      updatedAt: now
    };
    const annotations = active
      ? current.project.annotations.map((item) => item.id === active.id ? annotation : item)
      : [...current.project.annotations, annotation];
    const project = { ...current.project, annotations, activeAnnotationId: annotation.id };
    this.state.set({ project, errors: {}, saveError: null });
    await this.persist(project);
    return true;
  }

  private updateProject(update: (project: Project) => Project): void {
    this.state.update((value) => value.project ? { ...value, project: update(value.project), errors: {} } : value);
  }

  private scheduleRecovery(): void {
    this.cancelRecovery();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const project = get(this.state).project;
      if (project) void this.persist(project);
    }, 300);
  }

  private async persist(project: Project): Promise<void> {
    const request = this.saveInFlight
      ? this.saveQueue.then(() => this.save(project))
      : this.save(project);
    this.saveInFlight = true;
    this.saveQueue = request;
    void request.then(() => {
      if (this.saveQueue === request) this.saveInFlight = false;
    });
    await request;
  }

  private cancelRecovery(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  private async save(project: Project): Promise<void> {
    try {
      await this.bridge.saveProject(project);
    } catch (error) {
      this.state.update((value) => ({ ...value, saveError: String(error) }));
    }
  }
}
