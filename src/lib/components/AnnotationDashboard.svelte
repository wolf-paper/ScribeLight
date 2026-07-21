<script lang="ts">
  import type { ProjectStore } from '../state/projectStore';
  import { normalizeDraftForEventType } from '../domain/validation';
  import { formatTime } from '../domain/time';
  import type { EventType } from '../domain/types';
  import { stableColorSlot } from '../theme/palette';
  import AcousticTagSelect from './AcousticTagSelect.svelte';

  export let store: ProjectStore;
  export let disabled = false;

  let startBoundaryInput = '';
  let endBoundaryInput = '';
  let boundaryContextKey: string | null = null;
  let boundaryError: string | null = null;

  const intelligibilityOptions = [
    ['highly_intelligible', 'Highly intelligible'],
    ['partially_intelligible', 'Partially intelligible'],
    ['unintelligible', 'Unintelligible'],
    ['not_applicable', 'Not applicable']
  ] as const;

  $: {
    const project = $store.project;
    const nextContextKey = project ? JSON.stringify([
      project.audioIdentity.canonicalPath,
      project.audioIdentity.size,
      project.audioIdentity.modifiedMs,
      project.audioIdentity.durationMs,
      project.activeAnnotationId,
      project.activeSelection?.startMs ?? null,
      project.activeSelection?.endMs ?? null,
      project.draft.startMs,
      project.draft.endMs
    ]) : null;
    if (nextContextKey !== boundaryContextKey) {
      boundaryContextKey = nextContextKey;
      startBoundaryInput = project ? String(project.draft.startMs) : '';
      endBoundaryInput = project ? String(project.draft.endMs) : '';
      boundaryError = null;
    }
  }

  function parseBoundary(rawValue: string): number | null {
    if (!rawValue.trim()) return null;
    const value = Number(rawValue);
    return Number.isFinite(value) && Number.isInteger(value) ? value : null;
  }

  function completeBoundaryEdit(): boolean {
    if (disabled) return false;
    const project = $store.project;
    if (!project) return false;
    const startMs = parseBoundary(startBoundaryInput);
    const endMs = parseBoundary(endBoundaryInput);
    if (startMs === null || endMs === null || startMs < 0 || endMs <= startMs
      || endMs > project.audioIdentity.durationMs) {
      boundaryError = 'Enter a valid whole-millisecond range within the clip, with start before end.';
      return false;
    }
    boundaryError = null;
    if (startMs !== project.draft.startMs || endMs !== project.draft.endMs) {
      store.patchBoundaries({ startMs, endMs });
    }
    return true;
  }

  const submit = () => {
    if (!disabled && completeBoundaryEdit()) void store.commitDraft();
  };

  function onEditorKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submit();
  }

  function eventTypeChanged(event: Event) {
    if (disabled) return;
    const project = $store.project;
    if (!project) return;
    const eventType = (event.currentTarget as HTMLSelectElement).value as EventType;
    store.patchDraft(normalizeDraftForEventType(project.draft, eventType));
  }

  function boundaryKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    completeBoundaryEdit();
  }
</script>

{#if $store.project}
  {@const project = $store.project}
  <section class="annotation-dashboard selection-inspector" aria-label="Selection inspector">
    <h2>Selection</h2>
    <fieldset class="inspector-controls" disabled={disabled} aria-label="Annotation editor controls">
      <div class="inspector-body">
        <div class="boundary-grid">
          <label>
            Start
            <output aria-label="Loop start time">{formatTime(project.draft.startMs, project.displayFormat)}</output>
            <input
              aria-label="Start milliseconds"
              type="number"
              min="0"
              max={project.audioIdentity.durationMs}
              step="1"
              value={startBoundaryInput}
              aria-invalid={boundaryError ? 'true' : undefined}
              aria-describedby={boundaryError ? 'boundary-editing-help boundary-editing-error' : 'boundary-editing-help'}
              on:input={(event) => startBoundaryInput = (event.currentTarget as HTMLInputElement).value}
              on:change={completeBoundaryEdit}
              on:keydown={boundaryKeydown}
            />
          </label>
          <label>
            End
            <output aria-label="Loop end time">{formatTime(project.draft.endMs, project.displayFormat)}</output>
            <input
              aria-label="End milliseconds"
              type="number"
              min="1"
              max={project.audioIdentity.durationMs}
              step="1"
              value={endBoundaryInput}
              aria-invalid={boundaryError ? 'true' : undefined}
              aria-describedby={boundaryError ? 'boundary-editing-help boundary-editing-error' : 'boundary-editing-help'}
              on:input={(event) => endBoundaryInput = (event.currentTarget as HTMLInputElement).value}
              on:change={completeBoundaryEdit}
              on:keydown={boundaryKeydown}
            />
          </label>
          <div class="duration-readout">
            <span>Duration</span>
            <output aria-label="Selection duration">{formatTime(project.draft.endMs - project.draft.startMs, project.displayFormat)}</output>
          </div>
        </div>
        <p id="boundary-editing-help">Edit either value freely; the loop updates when both boundaries form a valid range.</p>

        <div class="inspector-pair">
          <label>
            Speaker
            <div class="speaker-select-control">
              {#if project.draft.speakerId}
                <span
                  class="speaker-color-cue"
                  data-testid="speaker-selection-cue"
                  data-color-slot={stableColorSlot(project.draft.speakerId, 5)}
                  aria-hidden="true"
                ></span>
              {/if}
              <select
                aria-label="Speaker"
                disabled={project.draft.eventType === 'non_speech'}
                value={project.draft.speakerId ?? ''}
                on:change={(event) => store.patchDraft({ speakerId: (event.currentTarget as HTMLSelectElement).value || null })}
              >
                {#if project.draft.eventType === 'non_speech'}
                  <option value="">None</option>
                {/if}
                {#each project.speakers as speaker}
                  <option value={speaker.id}>{speaker.label}</option>
                {/each}
              </select>
            </div>
          </label>
          <label>
            Event type
            <select aria-label="Event type" value={project.draft.eventType} on:change={eventTypeChanged}>
              <option value="speech">Speech</option>
              <option value="non_speech">Non-speech</option>
            </select>
          </label>
        </div>

        <div class="metadata-grid">
          <label>
            Intelligibility
            <select aria-label="Intelligibility" value={project.draft.intelligibility} on:change={(event) => store.patchDraft({ intelligibility: (event.currentTarget as HTMLSelectElement).value as typeof project.draft.intelligibility })}>
              {#each intelligibilityOptions as [value, label]}
                <option {value}>{label}</option>
              {/each}
            </select>
          </label>
          <label>
            Overlap
            <select aria-label="Overlap" value={project.draft.overlap} on:change={(event) => store.patchDraft({ overlap: (event.currentTarget as HTMLSelectElement).value as typeof project.draft.overlap })}>
              <option value="none">None</option>
              <option value="overlap">Overlap</option>
            </select>
          </label>
          <label>
            Confidence
            <select aria-label="Confidence" value={project.draft.confidence} on:change={(event) => store.patchDraft({ confidence: (event.currentTarget as HTMLSelectElement).value as typeof project.draft.confidence })}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
        </div>

        <div class="acoustic-tag-field">
          <span>Acoustic tags</span>
          <AcousticTagSelect
            tags={project.acousticTags}
            selectedIds={project.draft.acousticTagIds}
            {disabled}
            onchange={(acousticTagIds) => store.patchDraft({ acousticTagIds })}
          />
        </div>

        <label>
          Notes
          <textarea
            aria-label="Notes"
            rows="3"
            value={project.draft.notes}
            on:input={(event) => store.patchDraft({ notes: (event.currentTarget as HTMLTextAreaElement).value })}
            on:keydown={onEditorKeydown}
          ></textarea>
        </label>

        {#if boundaryError || Object.keys($store.errors).length}
          <div id={boundaryError ? 'boundary-editing-error' : undefined} role="alert">
            {boundaryError ?? 'Correct the highlighted annotation fields.'}
          </div>
        {/if}
      </div>

      <div class="actions">
        <button type="button" on:click={submit}>{project.activeAnnotationId ? 'Update annotation' : 'Add annotation'}</button>
        {#if project.activeAnnotationId}
          <button type="button" on:click={() => {
            if (!disabled) void store.removeAnnotation(project.activeAnnotationId!);
          }}>Remove annotation</button>
        {/if}
        <button type="button" on:click={() => store.clearDraft()}>Clear</button>
      </div>
    </fieldset>
  </section>
{/if}
