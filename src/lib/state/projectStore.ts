import { get, writable, type Readable } from 'svelte/store';
import { emptyDraft } from '../domain/project';
import type { Annotation, AnnotationDraft, Project, Selection } from '../domain/types';
import { validateDraft, type FieldErrors } from '../domain/validation';
import { formatUnknownError } from '../errors';

interface SaveBridge {
  saveProject(project: Project): Promise<void>;
}

interface AnnotationSelectionContext {
  annotationId: string;
  draftFieldRevisions: Record<keyof AnnotationDraft, number>;
  selectionRevision: number;
}

const draftFields: readonly (keyof AnnotationDraft)[] = [
  'startMs', 'endMs', 'eventType', 'transcription', 'intelligibility',
  'speakerId', 'overlap', 'confidence', 'acousticTagIds', 'notes'
];

function draftFromAnnotation(annotation: Annotation): AnnotationDraft {
  return {
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
}

function sameDraft(left: AnnotationDraft, right: AnnotationDraft): boolean {
  return draftFields.every((field) => field === 'acousticTagIds'
    ? left.acousticTagIds.length === right.acousticTagIds.length
      && left.acousticTagIds.every((id, index) => id === right.acousticTagIds[index])
    : left[field] === right[field]);
}

function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

function validDraftSelection(draft: AnnotationDraft, durationMs: number): Selection | null {
  return Number.isInteger(draft.startMs) && Number.isInteger(draft.endMs)
    && draft.startMs >= 0 && draft.endMs > draft.startMs && draft.endMs <= durationMs
    ? { startMs: draft.startMs, endMs: draft.endMs }
    : null;
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
  private projectRevision = 0;
  private draftFieldRevisions: Record<keyof AnnotationDraft, number> = {
    startMs: 0, endMs: 0, eventType: 0, transcription: 0, intelligibility: 0,
    speakerId: 0, overlap: 0, confidence: 0, acousticTagIds: 0, notes: 0
  };
  private selectionRevision = 0;
  private activeAnnotationRevision = 0;
  private annotationSelection: AnnotationSelectionContext | null = null;
  readonly subscribe = this.state.subscribe;

  constructor(
    private readonly bridge: SaveBridge,
    private readonly id: () => string = () => crypto.randomUUID(),
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  open(project: Project): void {
    this.cancelRecovery();
    this.projectRevision += 1;
    this.markDraftFields(draftFields);
    this.selectionRevision += 1;
    this.activeAnnotationRevision += 1;
    this.annotationSelection = null;
    const opened = project.activeAnnotationId
      && !project.annotations.some((annotation) => annotation.id === project.activeAnnotationId)
      ? { ...project, activeAnnotationId: null }
      : project;
    this.state.update((value) => ({
      project: opened,
      errors: opened.activeAnnotationId ? validateDraft(opened.draft, opened) : {},
      saveError: value.saveError
    }));
  }

  setMutationsBlocked(blocked: boolean): void {
    this.mutationsBlocked = blocked;
  }

  patchDraft(patch: Partial<AnnotationDraft>): void {
    if (this.mutationsBlocked) return;
    this.markDraftFields(Object.keys(patch) as (keyof AnnotationDraft)[]);
    this.applyEdit((project) => ({ ...project, draft: { ...project.draft, ...patch } }));
    this.scheduleRecovery();
  }

  patchBoundaries(patch: Partial<Pick<AnnotationDraft, 'startMs' | 'endMs'>>): void {
    if (this.mutationsBlocked) return;
    const current = get(this.state).project;
    if (!current) return;
    const fields = Object.keys(patch) as ('startMs' | 'endMs')[];
    this.markDraftFields(fields);
    const draft = { ...current.draft, ...patch };
    const validSelection = validDraftSelection(draft, current.audioIdentity.durationMs);
    if (validSelection && (
      current.activeSelection?.startMs !== validSelection.startMs
      || current.activeSelection.endMs !== validSelection.endMs
    )) this.selectionRevision += 1;
    this.applyEdit((project) => ({
      ...project,
      draft,
      activeSelection: validSelection ?? project.activeSelection
    }));
    this.scheduleRecovery();
  }

  setSelection(selection: Selection | null): void {
    if (this.mutationsBlocked) return;
    this.selectionRevision += 1;
    if (selection) this.markDraftFields(['startMs', 'endMs']);
    this.applyEdit((project) => ({
      ...project,
      activeSelection: selection,
      draft: selection ? { ...project.draft, ...selection } : project.draft
    }));
    this.scheduleRecovery();
  }

  selectAnnotation(id: string): void {
    if (this.mutationsBlocked) return;
    const annotation = get(this.state).project?.annotations.find((item) => item.id === id);
    if (!annotation) return;
    this.markDraftFields(draftFields);
    this.selectionRevision += 1;
    this.activeAnnotationRevision += 1;
    this.applyEdit((project) => ({
      ...project,
      activeAnnotationId: id,
      activeSelection: { startMs: annotation.startMs, endMs: annotation.endMs },
      draft: draftFromAnnotation(annotation)
    }));
    this.annotationSelection = {
      annotationId: id,
      draftFieldRevisions: { ...this.draftFieldRevisions },
      selectionRevision: this.selectionRevision
    };
    this.scheduleRecovery();
  }

  /** Leaves any active annotation and starts an unsaved draft, optionally covering `selection`. */
  beginDraft(selection: Selection | null): void {
    if (this.mutationsBlocked) return;
    if (!get(this.state).project) return;
    const range = selection ? { startMs: selection.startMs, endMs: selection.endMs } : null;
    this.markDraftFields(draftFields);
    this.selectionRevision += 1;
    this.activeAnnotationRevision += 1;
    this.annotationSelection = null;
    this.applyEdit((project) => ({
      ...project,
      activeAnnotationId: null,
      activeSelection: range,
      draft: { ...emptyDraft(), ...range, speakerId: project.speakers[0]?.id ?? null }
    }));
    this.scheduleRecovery();
  }

  /** Stores the new draft as an annotation and makes it active; later edits to it save automatically. */
  addDraft(): Promise<boolean> {
    if (this.mutationsBlocked) return Promise.resolve(false);
    return this.enqueueMutation((project) => {
      if (project.activeAnnotationId) return null;
      const errors = validateDraft(project.draft, project);
      if (hasErrors(errors)) {
        this.state.update((value) => ({ ...value, errors }));
        return null;
      }
      const now = this.now();
      const annotation: Annotation = {
        ...project.draft,
        acousticTagIds: [...project.draft.acousticTagIds],
        id: this.id(),
        createdAt: now,
        updatedAt: now
      };
      return {
        ...project,
        annotations: [...project.annotations, annotation],
        activeAnnotationId: annotation.id,
        activeSelection: { startMs: annotation.startMs, endMs: annotation.endMs }
      };
    }, this.cancelRecovery());
  }

  /** Resolves to the removed annotation (for undo), or null when nothing was removed. */
  async removeAnnotation(id: string): Promise<Annotation | null> {
    if (this.mutationsBlocked) return null;
    let removed = null as Annotation | null;
    const succeeded = await this.enqueueMutation((current) => {
      removed = current.annotations.find((item) => item.id === id) ?? null;
      if (!removed) return null;
      const wasActive = current.activeAnnotationId === id;
      return {
        ...current,
        annotations: current.annotations.filter((item) => item.id !== id),
        activeAnnotationId: wasActive ? null : current.activeAnnotationId,
        activeSelection: wasActive ? null : current.activeSelection,
        draft: wasActive ? { ...emptyDraft(), speakerId: current.speakers[0]?.id ?? null } : current.draft
      };
    }, this.cancelRecovery());
    return succeeded ? removed : null;
  }

  /** Re-inserts a removed annotation without changing which annotation is active. */
  restoreAnnotation(annotation: Annotation): Promise<boolean> {
    if (this.mutationsBlocked) return Promise.resolve(false);
    return this.enqueueMutation((project) => {
      if (project.annotations.some((item) => item.id === annotation.id)) return null;
      if (hasErrors(validateDraft(annotation, project))) return null;
      return {
        ...project,
        annotations: [...project.annotations, { ...annotation, acousticTagIds: [...annotation.acousticTagIds] }]
      };
    }, this.cancelRecovery());
  }

  mutateProject(mutation: (project: Project) => Project): Promise<boolean> {
    if (this.mutationsBlocked) return Promise.resolve(false);
    return this.enqueueMutation(mutation, this.cancelRecovery());
  }

  async flush(): Promise<boolean> {
    this.cancelRecovery();
    await this.mutationQueue;
    await this.saveQueue;
    const project = get(this.state).project;
    return project ? this.persist(project) : true;
  }

  /** Applies a local edit and autosaves the active annotation in the same state update. */
  private applyEdit(update: (project: Project) => Project): void {
    this.state.update((value) => {
      if (!value.project) return value;
      const { project, errors } = this.syncActiveAnnotation(update(value.project));
      return { ...value, project, errors };
    });
  }

  /**
   * Rewrites the active annotation from the draft when the draft is structurally valid and differs.
   * `previous` lets a republished annotation keep the timestamp of an identical earlier autosave.
   */
  private syncActiveAnnotation(project: Project, previous?: readonly Annotation[]): { project: Project; errors: FieldErrors } {
    const index = project.activeAnnotationId
      ? project.annotations.findIndex((item) => item.id === project.activeAnnotationId)
      : -1;
    if (index < 0) return { project, errors: {} };
    const errors = validateDraft(project.draft, project);
    const annotation = project.annotations[index];
    if (hasErrors(errors) || sameDraft(annotation, project.draft)) return { project, errors };
    const earlier = previous?.find((item) => item.id === annotation.id);
    const annotations = [...project.annotations];
    annotations[index] = {
      ...project.draft,
      acousticTagIds: [...project.draft.acousticTagIds],
      id: annotation.id,
      createdAt: annotation.createdAt,
      updatedAt: earlier && sameDraft(earlier, project.draft) ? earlier.updatedAt : this.now()
    };
    return { project: { ...project, annotations }, errors };
  }

  private markDraftFields(fields: readonly (keyof AnnotationDraft)[]): void {
    for (const field of fields) this.draftFieldRevisions[field] += 1;
  }

  private mergeEditsAfterSelection(
    base: AnnotationDraft,
    latest: AnnotationDraft,
    context: AnnotationSelectionContext,
    candidate: Project
  ): AnnotationDraft {
    const changed = (field: keyof AnnotationDraft): boolean =>
      this.draftFieldRevisions[field] !== context.draftFieldRevisions[field];
    const requestedSpeakerId = changed('speakerId') ? latest.speakerId : base.speakerId;
    const baseSpeakerId = base.speakerId === null || candidate.speakers.some((speaker) => speaker.id === base.speakerId)
      ? base.speakerId
      : candidate.speakers[0]?.id ?? null;
    const speakerId = requestedSpeakerId === null || candidate.speakers.some((speaker) => speaker.id === requestedSpeakerId)
      ? requestedSpeakerId
      : baseSpeakerId;
    const requestedTagIds = changed('acousticTagIds') ? latest.acousticTagIds : base.acousticTagIds;
    return {
      startMs: changed('startMs') ? latest.startMs : base.startMs,
      endMs: changed('endMs') ? latest.endMs : base.endMs,
      eventType: changed('eventType') ? latest.eventType : base.eventType,
      transcription: changed('transcription') ? latest.transcription : base.transcription,
      intelligibility: changed('intelligibility') ? latest.intelligibility : base.intelligibility,
      speakerId,
      overlap: changed('overlap') ? latest.overlap : base.overlap,
      confidence: changed('confidence') ? latest.confidence : base.confidence,
      acousticTagIds: requestedTagIds.filter((id) => candidate.acousticTags.some((tag) => tag.id === id)),
      notes: changed('notes') ? latest.notes : base.notes
    };
  }

  private scheduleRecovery(): void {
    this.cancelRecovery();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.mutationInFlight) {
        const project = get(this.state).project;
        if (project) void this.persist(project);
        return;
      }
      void this.mutationQueue.then(() => {
        const project = get(this.state).project;
        if (project) void this.persist(project);
      });
    }, 300);
  }

  /**
   * `recoveryPending` reports a recovery write the mutation's own save replaces; it is rescheduled
   * when the mutation stores nothing so earlier edits still reach disk.
   */
  private enqueueMutation(mutation: (project: Project) => Project | null, recoveryPending: boolean): Promise<boolean> {
    const request = this.mutationInFlight
      ? this.mutationQueue.then(() => this.applyMutation(mutation, recoveryPending))
      : this.applyMutation(mutation, recoveryPending);
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

  private async applyMutation(mutation: (project: Project) => Project | null, recoveryPending: boolean): Promise<boolean> {
    const current = get(this.state).project;
    if (!current) return false;
    const projectRevision = this.projectRevision;
    const draftFieldRevisions = { ...this.draftFieldRevisions };
    const selectionRevision = this.selectionRevision;
    const activeAnnotationRevision = this.activeAnnotationRevision;
    const keepRecovery = (): false => {
      if (recoveryPending && this.projectRevision === projectRevision) this.scheduleRecovery();
      return false;
    };
    let candidate: Project | null;
    try {
      candidate = mutation(current);
    } catch (error) {
      this.state.update((value) => ({
        ...value,
        saveError: formatUnknownError(error)
      }));
      return keepRecovery();
    }
    if (!candidate) return keepRecovery();
    if (!await this.persist(candidate)) return keepRecovery();
    if (this.projectRevision !== projectRevision) return false;
    const latestState = get(this.state);
    const latest = latestState.project;
    if (!latest) return false;
    const draftChanged = (field: keyof AnnotationDraft): boolean =>
      this.draftFieldRevisions[field] !== draftFieldRevisions[field];
    const latestSpeakerId = draftChanged('speakerId') ? latest.draft.speakerId : candidate.draft.speakerId;
    const speakerId = latestSpeakerId === null || candidate.speakers.some((speaker) => speaker.id === latestSpeakerId)
      ? latestSpeakerId
      : candidate.draft.speakerId;
    const acousticTagIds = draftChanged('acousticTagIds')
      ? latest.draft.acousticTagIds.filter((id) => candidate.acousticTags.some((tag) => tag.id === id))
      : candidate.draft.acousticTagIds;
    const draft: AnnotationDraft = {
      startMs: draftChanged('startMs') ? latest.draft.startMs : candidate.draft.startMs,
      endMs: draftChanged('endMs') ? latest.draft.endMs : candidate.draft.endMs,
      eventType: draftChanged('eventType') ? latest.draft.eventType : candidate.draft.eventType,
      transcription: draftChanged('transcription') ? latest.draft.transcription : candidate.draft.transcription,
      intelligibility: draftChanged('intelligibility') ? latest.draft.intelligibility : candidate.draft.intelligibility,
      speakerId,
      overlap: draftChanged('overlap') ? latest.draft.overlap : candidate.draft.overlap,
      confidence: draftChanged('confidence') ? latest.draft.confidence : candidate.draft.confidence,
      acousticTagIds,
      notes: draftChanged('notes') ? latest.draft.notes : candidate.draft.notes
    };
    let published: Project = {
      ...candidate,
      draft,
      activeSelection: this.selectionRevision !== selectionRevision
        ? latest.activeSelection
        : candidate.activeSelection,
      activeAnnotationId: this.activeAnnotationRevision === activeAnnotationRevision
        ? candidate.activeAnnotationId
        : latest.activeAnnotationId
    };
    const activeChanged = this.activeAnnotationRevision !== activeAnnotationRevision;
    const selectionContext = this.annotationSelection;
    if (activeChanged && latest.activeAnnotationId && selectionContext?.annotationId === latest.activeAnnotationId) {
      const selectedCandidate = candidate.annotations.find((annotation) => annotation.id === latest.activeAnnotationId);
      if (selectedCandidate) {
        published = {
          ...published,
          activeAnnotationId: selectedCandidate.id,
          activeSelection: this.selectionRevision === selectionContext.selectionRevision
            ? { startMs: selectedCandidate.startMs, endMs: selectedCandidate.endMs }
            : latest.activeSelection,
          draft: this.mergeEditsAfterSelection(
            draftFromAnnotation(selectedCandidate),
            latest.draft,
            selectionContext,
            candidate
          )
        };
      } else {
        const candidateActive = candidate.activeAnnotationId
          ? candidate.annotations.find((annotation) => annotation.id === candidate.activeAnnotationId)
          : null;
        published = candidateActive ? {
          ...published,
          activeAnnotationId: candidateActive.id,
          activeSelection: candidate.activeSelection,
          draft: candidate.draft
        } : {
          ...published,
          activeAnnotationId: null,
          activeSelection: this.selectionRevision === selectionContext.selectionRevision
            ? candidate.activeSelection
            : latest.activeSelection,
          draft: this.mergeEditsAfterSelection(candidate.draft, latest.draft, selectionContext, candidate)
        };
      }
    }
    if (published.activeAnnotationId
      && !published.annotations.some((annotation) => annotation.id === published.activeAnnotationId)) {
      published = {
        ...published,
        activeAnnotationId: null,
        activeSelection: candidate.activeSelection,
        draft: candidate.draft
      };
    }
    // The candidate carries the annotation list from before the save; re-apply edits autosaved meanwhile.
    const synced = this.syncActiveAnnotation(published, latest.annotations);
    if (this.annotationSelection?.annotationId !== synced.project.activeAnnotationId) this.annotationSelection = null;
    this.state.set({
      project: synced.project,
      errors: synced.project.activeAnnotationId ? synced.errors : latest.activeAnnotationId ? {} : latestState.errors,
      saveError: null
    });
    const editedMeanwhile = draftFields.some(draftChanged)
      || this.selectionRevision !== selectionRevision
      || this.activeAnnotationRevision !== activeAnnotationRevision;
    // Edits made meanwhile scheduled their own recovery write; otherwise persist the resynced annotation here.
    if (synced.project !== published && !editedMeanwhile) this.scheduleRecovery();
    return true;
  }

  private cancelRecovery(): boolean {
    if (!this.saveTimer) return false;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    return true;
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
    this.state.update((value) => ({ ...value, saveError: formatUnknownError(error) }));
  }
}
