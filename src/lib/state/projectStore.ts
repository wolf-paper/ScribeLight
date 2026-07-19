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
  private mutationQueue: Promise<void> = Promise.resolve();
  private mutationInFlight = false;
  private mutationsBlocked = false;
  readonly subscribe = this.state.subscribe;

  constructor(private readonly bridge: SaveBridge, private readonly id: () => string = () => crypto.randomUUID()) {}

  open(project: Project): void {
    this.cancelRecovery();
    this.state.update((value) => ({ project, errors: {}, saveError: value.saveError }));
  }

  setMutationsBlocked(blocked: boolean): void {
    this.mutationsBlocked = blocked;
  }

  patchDraft(patch: Partial<AnnotationDraft>): void {
    if (this.mutationsBlocked) return;
    this.updateProject((project) => ({ ...project, draft: { ...project.draft, ...patch } }));
    this.scheduleRecovery();
  }

  setSelection(selection: Selection | null): void {
    if (this.mutationsBlocked) return;
    this.updateProject((project) => ({
      ...project,
      activeSelection: selection,
      draft: selection ? { ...project.draft, ...selection } : project.draft
    }));
    this.scheduleRecovery();
  }

  selectAnnotation(id: string): void {
    if (this.mutationsBlocked) return;
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
    if (this.mutationsBlocked) return;
    this.cancelRecovery();
    await this.enqueueMutation((current) => {
      const wasActive = current.activeAnnotationId === id;
      return {
        ...current,
        annotations: current.annotations.filter((item) => item.id !== id),
        activeAnnotationId: wasActive ? null : current.activeAnnotationId,
        activeSelection: wasActive ? null : current.activeSelection,
        draft: wasActive ? { ...emptyDraft(), speakerId: current.speakers[0]?.id ?? null } : current.draft
      };
    });
  }

  mutateProject(mutation: (project: Project) => Project): Promise<boolean> {
    if (this.mutationsBlocked) return Promise.resolve(false);
    this.cancelRecovery();
    return this.enqueueMutation(mutation);
  }

  async flush(): Promise<boolean> {
    this.cancelRecovery();
    await this.mutationQueue;
    await this.saveQueue;
    const project = get(this.state).project;
    return project ? this.persist(project) : true;
  }

  clearDraft(): void {
    if (this.mutationsBlocked) return;
    this.updateProject((project) => ({
      ...project,
      activeAnnotationId: null,
      activeSelection: null,
      draft: { ...emptyDraft(), speakerId: project.speakers[0]?.id ?? null }
    }));
  }

  async commitDraft(now = new Date().toISOString()): Promise<boolean> {
    if (this.mutationsBlocked) return false;
    this.cancelRecovery();
    return this.enqueueMutation((project) => {
      const errors = validateDraft(project.draft, project);
      if (Object.keys(errors).length) {
        this.state.update((value) => ({ ...value, errors }));
        return null;
      }
      const active = project.annotations.find((item) => item.id === project.activeAnnotationId);
      const annotation: Annotation = {
        ...project.draft,
        id: active?.id ?? this.id(),
        createdAt: active?.createdAt ?? now,
        updatedAt: now
      };
      const annotations = active
        ? project.annotations.map((item) => item.id === active.id ? annotation : item)
        : [...project.annotations, annotation];
      return { ...project, annotations, activeAnnotationId: annotation.id };
    });
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

  private enqueueMutation(mutation: (project: Project) => Project | null): Promise<boolean> {
    const request = this.mutationInFlight
      ? this.mutationQueue.then(() => this.applyMutation(mutation))
      : this.applyMutation(mutation);
    this.mutationInFlight = true;
    const settled = request.then(() => undefined, () => undefined);
    this.mutationQueue = settled;
    void settled.then(() => {
      if (this.mutationQueue === settled) this.mutationInFlight = false;
    });
    return request;
  }

  private persist(project: Project): Promise<boolean> {
    const request = this.saveInFlight
      ? this.saveQueue.then(() => this.save(project))
      : this.save(project);
    this.saveInFlight = true;
    const settled = request.then(() => undefined, () => undefined);
    this.saveQueue = settled;
    void settled.then(() => {
      if (this.saveQueue === settled) this.saveInFlight = false;
    });
    return request;
  }

  private async applyMutation(mutation: (project: Project) => Project | null): Promise<boolean> {
    const current = get(this.state).project;
    if (!current) return false;
    let candidate: Project | null;
    try {
      candidate = mutation(current);
    } catch (error) {
      this.state.update((value) => ({
        ...value,
        saveError: error instanceof Error ? error.message : String(error)
      }));
      return false;
    }
    if (!candidate) return false;
    if (!await this.persist(candidate)) return false;
    this.state.set({ project: candidate, errors: {}, saveError: null });
    return true;
  }

  private cancelRecovery(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  private async save(project: Project): Promise<boolean> {
    try {
      await this.bridge.saveProject(project);
      return true;
    } catch (error) {
      this.setSaveError(error);
      return false;
    }
  }

  private setSaveError(error: unknown): void {
    this.state.update((value) => ({ ...value, saveError: String(error) }));
  }
}
