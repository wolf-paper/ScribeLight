<script lang="ts">
  import type { ProjectStore } from '../state/projectStore';
  import type { AnnotationDraft, Confidence, Intelligibility, Overlap } from '../domain/types';
  import { formatDuration, formatTime, parseTime } from '../domain/time';
  import { normalizeDraftForEventType, worksheetErrors } from '../domain/validation';
  import { stableColorSlot } from '../theme/palette';
  import AcousticTagSelect from './AcousticTagSelect.svelte';
  import SegmentedControl from './SegmentedControl.svelte';

  interface Props {
    store: ProjectStore;
    disabled?: boolean;
    /** 1-based position of the active annotation in time order, or null for a new draft. */
    annotationNumber: number | null;
    annotationCount: number;
    onsetboundary: (kind: 'start' | 'end') => void;
    onplayrange: () => void;
    ondelete: (id: string) => void;
  }

  let { store, disabled = false, annotationNumber, annotationCount, onsetboundary, onplayrange, ondelete }: Props = $props();

  let transcriptionField = $state<HTMLTextAreaElement | null>(null);
  let startText = $state('');
  let endText = $state('');
  let editingBoundary = $state<'start' | 'end' | null>(null);
  let boundaryError = $state<string | null>(null);

  const project = $derived($store.project);
  const draft = $derived(project?.draft ?? null);
  const activeId = $derived(project?.activeAnnotationId ?? null);
  const isNew = $derived(activeId === null);
  const hasRange = $derived(Boolean(draft && draft.endMs > draft.startMs));
  const allProblems = $derived(draft && project ? worksheetErrors(draft, project) : {});
  /** Review reasons in the order the fields appear. A new draft without a range has nothing to review yet. */
  const fieldOrder: string[] = ['startMs', 'endMs', 'transcription', 'eventType', 'speakerId', 'intelligibility', 'overlap', 'confidence', 'acousticTagIds', 'notes'];
  const problemList = $derived(isNew && !hasRange ? [] : Object.entries(allProblems)
    .sort(([left], [right]) => fieldOrder.indexOf(left) - fieldOrder.indexOf(right))
    .map(([, message]) => message)
    .filter((message): message is string => Boolean(message)));
  /** Fields are only marked once the annotation exists; a new draft just lists what is still needed. */
  const problems = $derived(isNew ? {} : allProblems);
  const saveErrors = $derived(Object.values($store.errors).filter((message): message is string => Boolean(message)));
  const overlapTagId = $derived(project?.acousticTags.find((tag) => tag.label === 'overlap')?.id ?? null);

  $effect(() => {
    if (!draft) return;
    if (editingBoundary !== 'start') startText = formatTime(draft.startMs);
    if (editingBoundary !== 'end') endText = formatTime(draft.endMs);
  });

  export function focusTranscription(): void {
    transcriptionField?.focus();
  }

  function patch(next: Partial<AnnotationDraft>): void {
    if (!disabled) store.patchDraft(next);
  }

  function singleLine(value: string): string {
    return value.replace(/\r\n|\r|\n/g, ' ');
  }

  function commitBoundary(kind: 'start' | 'end'): void {
    if (!draft || !project) return;
    editingBoundary = null;
    const parsed = parseTime(kind === 'start' ? startText : endText);
    const durationMs = project.audioIdentity.durationMs;
    const startMs = kind === 'start' ? parsed : draft.startMs;
    let endMs = kind === 'end' ? parsed : draft.endMs;
    // Like the I key: a start typed into a draft that has no range yet gets a provisional one-second range.
    if (kind === 'start' && !hasRange && parsed !== null && parsed < durationMs) {
      endMs = Math.min(durationMs, parsed + 1_000);
    }
    if (startMs === null || endMs === null || endMs <= startMs || endMs > durationMs) {
      boundaryError = `Enter a time like 1:23.456 between 0:00.000 and ${formatTime(durationMs)}, with the start before the end.`;
      startText = formatTime(draft.startMs);
      endText = formatTime(draft.endMs);
      return;
    }
    boundaryError = null;
    if (startMs !== draft.startMs || endMs !== draft.endMs) store.patchBoundaries({ startMs, endMs });
  }

  function boundaryKeydown(event: KeyboardEvent, kind: 'start' | 'end'): void {
    if (!draft || !project || event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commitBoundary(kind);
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const step = (event.shiftKey ? 100 : 10) * (event.key === 'ArrowUp' ? 1 : -1);
    const startMs = kind === 'start' ? draft.startMs + step : draft.startMs;
    const endMs = kind === 'end' ? draft.endMs + step : draft.endMs;
    if (startMs < 0 || endMs <= startMs || endMs > project.audioIdentity.durationMs) return;
    editingBoundary = null;
    boundaryError = null;
    store.patchBoundaries({ startMs, endMs });
  }

  function transcriptionKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    if (isNew && !event.shiftKey) void add();
  }

  async function add(): Promise<void> {
    if (disabled || !isNew || !hasRange) return;
    await store.addDraft();
  }

  /** The Speaker row also offers "Non-speech", which is the event type rather than a speaker. */
  const nonSpeechChoice = '__non_speech__';

  function setSpeaker(choice: string): void {
    if (!draft) return;
    if (choice === nonSpeechChoice) patch(normalizeDraftForEventType(draft, 'non_speech'));
    else if (draft.eventType === 'non_speech') patch({ ...normalizeDraftForEventType(draft, 'speech'), speakerId: choice });
    else patch({ speakerId: choice });
  }

  function withOverlapTag(ids: string[], present: boolean): string[] {
    if (!overlapTagId) return ids;
    const without = ids.filter((id) => id !== overlapTagId);
    return present ? [...without, overlapTagId] : without;
  }

  function setOverlap(overlap: Overlap): void {
    if (draft) patch({ overlap, acousticTagIds: withOverlapTag(draft.acousticTagIds, overlap === 'overlap') });
  }

  function setTags(acousticTagIds: string[]): void {
    if (!draft) return;
    const hadOverlapTag = overlapTagId !== null && draft.acousticTagIds.includes(overlapTagId);
    const hasOverlapTag = overlapTagId !== null && acousticTagIds.includes(overlapTagId);
    if (hadOverlapTag === hasOverlapTag || draft.eventType === 'non_speech') patch({ acousticTagIds });
    else patch({ acousticTagIds, overlap: hasOverlapTag ? 'overlap' : 'none' });
  }

  const intelligibilityOptions: { value: Intelligibility; label: string }[] = [
    { value: 'highly_intelligible', label: 'Intelligible' },
    { value: 'partially_intelligible', label: 'Partly' },
    { value: 'unintelligible', label: 'Unintelligible' }
  ];
  const confidenceOptions: { value: Confidence; label: string }[] = [
    { value: 'high', label: 'High' },
    { value: 'medium', label: 'Medium' },
    { value: 'low', label: 'Low' }
  ];
</script>

{#if project && draft}
  <section class="editor" aria-labelledby="editor-title">
    <header class="editor-header">
      <div>
        <h2 id="editor-title">
          {#if isNew}New annotation{:else}Annotation {annotationNumber} of {annotationCount}{/if}
        </h2>
        <p class="editor-range">
          {#if hasRange}
            {formatTime(draft.startMs)} – {formatTime(draft.endMs)} · {formatDuration(draft.endMs - draft.startMs)}
          {:else}
            Drag across the waveform, or press I and O while listening, to mark a range.
          {/if}
        </p>
      </div>
      <div class="editor-header-side">
        <p class="save-state" class:unsaved={!isNew && saveErrors.length > 0} role="status">
          {#if isNew}
            Not added yet
          {:else if saveErrors.length}
            Not saved: {saveErrors[0]}
          {:else}
            Saved
          {/if}
        </p>
        <button type="button" class="ghost" disabled={!hasRange || disabled} title="Play the range from its start" onclick={onplayrange}><span aria-hidden="true">▶</span> Play range</button>
      </div>
    </header>

    <fieldset class="editor-body" {disabled}>
      <legend class="visually-hidden">Annotation fields</legend>

      {#if problemList.length}
        <p class="review-note" role="note" aria-label="Yamabiko review">
          <strong>{isNew ? 'Still needed:' : 'Needs review:'}</strong>
          {problemList.join(' · ')}
        </p>
      {/if}

      <div class="range-row">
        <label class="time-field">
          <span>Start</span>
          <input
            aria-label="Start time"
            type="text"
            inputmode="decimal"
            spellcheck="false"
            value={startText}
            aria-invalid={boundaryError || $store.errors.startMs ? 'true' : undefined}
            onfocus={() => editingBoundary = 'start'}
            oninput={(event) => startText = event.currentTarget.value}
            onblur={() => commitBoundary('start')}
            onkeydown={(event) => boundaryKeydown(event, 'start')}
          />
        </label>
        <button type="button" class="ghost key-button" title="Set start to the playhead (I)" onclick={() => onsetboundary('start')}>
          Set <kbd>I</kbd>
        </button>
        <label class="time-field">
          <span>End</span>
          <input
            aria-label="End time"
            type="text"
            inputmode="decimal"
            spellcheck="false"
            value={endText}
            aria-invalid={boundaryError || $store.errors.endMs ? 'true' : undefined}
            onfocus={() => editingBoundary = 'end'}
            oninput={(event) => endText = event.currentTarget.value}
            onblur={() => commitBoundary('end')}
            onkeydown={(event) => boundaryKeydown(event, 'end')}
          />
        </label>
        <button type="button" class="ghost key-button" title="Set end to the playhead (O)" onclick={() => onsetboundary('end')}>
          Set <kbd>O</kbd>
        </button>
      </div>
      {#if boundaryError}
        <p class="field-error" role="alert">{boundaryError}</p>
      {/if}

      <label class="transcription-field">
        <span>Transcription</span>
        <textarea
          bind:this={transcriptionField}
          aria-label="Transcription"
          rows="2"
          placeholder={draft.eventType === 'non_speech' ? 'Non-speech has no transcription' : 'Type what is said'}
          value={draft.transcription}
          aria-invalid={problems.transcription ? 'true' : undefined}
          oninput={(event) => patch({ transcription: singleLine(event.currentTarget.value) })}
          onkeydown={transcriptionKeydown}
        ></textarea>
      </label>

      <div class="field">
        <span class="field-label">Speaker</span>
        <SegmentedControl
          label="Speaker"
          value={draft.eventType === 'non_speech' ? nonSpeechChoice : draft.speakerId}
          invalid={Boolean(problems.speakerId)}
          options={[
            ...project.speakers.map((speaker) => ({
              value: speaker.id,
              label: speaker.label.replace(/^speaker_/, ''),
              ariaLabel: speaker.label,
              hint: speaker.label,
              colorSlot: stableColorSlot(speaker.id, 5)
            })),
            { value: nonSpeechChoice, label: 'Non-speech', hint: 'No one is speaking: noise, music, or other sound' }
          ]}
          onchange={setSpeaker}
        />
      </div>

      <div class="field">
        <span class="field-label">Intelligibility</span>
        {#if draft.eventType === 'speech'}
          <SegmentedControl
            label="Intelligibility"
            value={draft.intelligibility}
            invalid={Boolean(problems.intelligibility)}
            options={intelligibilityOptions}
            onchange={(intelligibility) => patch({ intelligibility })}
          />
        {:else}
          <span class="field-static">Not applicable</span>
        {/if}
      </div>

      <div class="field">
        <span class="field-label">Overlap</span>
        <div class="inline-fields">
          <SegmentedControl
            label="Overlap"
            value={draft.overlap}
            disabled={draft.eventType === 'non_speech'}
            invalid={Boolean(problems.overlap)}
            options={[{ value: 'none', label: 'No' }, { value: 'overlap', label: 'Yes' }]}
            onchange={setOverlap}
          />
          <span class="field-label">Confidence</span>
          <SegmentedControl
            label="Confidence"
            value={draft.confidence}
            invalid={Boolean(problems.confidence)}
            options={confidenceOptions}
            onchange={(confidence) => patch({ confidence })}
          />
        </div>
      </div>

      <div class="field" class:invalid-field={Boolean(problems.acousticTagIds)}>
        <span class="field-label">Acoustic tags</span>
        <AcousticTagSelect tags={project.acousticTags} selectedIds={draft.acousticTagIds} {disabled} onchange={setTags} />
      </div>

      <label class="field notes-field">
        <span class="field-label">Notes</span>
        <textarea
          aria-label="Notes"
          rows="1"
          value={draft.notes}
          aria-invalid={problems.notes ? 'true' : undefined}
          oninput={(event) => patch({ notes: singleLine(event.currentTarget.value) })}
          onkeydown={(event) => { if (event.key === 'Enter' && !event.isComposing) event.preventDefault(); }}
        ></textarea>
      </label>
    </fieldset>

    <footer class="editor-actions">
      {#if isNew}
        <button type="button" class="ghost" {disabled} onclick={() => store.beginDraft(null)}>Discard</button>
        <button type="button" class="primary" disabled={disabled || !hasRange} onclick={() => void add()}>
          Add annotation <kbd>Enter</kbd>
        </button>
      {:else}
        <button type="button" class="ghost danger" {disabled} onclick={() => activeId && ondelete(activeId)}>Delete</button>
        <button type="button" {disabled} title="Leave this annotation and start a new one (Esc)" onclick={() => store.beginDraft(null)}>
          New annotation <kbd>Esc</kbd>
        </button>
      {/if}
    </footer>
  </section>
{/if}
