<script lang="ts">
  import { formatTime } from '../domain/time';
  import type { Intelligibility, TimeDisplayFormat } from '../domain/types';
  import { stableColorSlot } from '../theme/palette';

  export interface AnnotationRow {
    id: string;
    startMs: number;
    endMs: number;
    speakerId: string | null;
    speaker: string;
    transcription: string;
    tags: { id: string; label: string }[];
    intelligibility: Intelligibility;
  }

  interface Props {
    annotations: AnnotationRow[];
    activeId?: string | null;
    format: TimeDisplayFormat;
    disabled?: boolean;
    onselect: (id: string) => void;
    onremove: (id: string) => void;
  }

  const speakerColorSlots = 5;
  const tagColorSlots = 5;
  const intelligibilityDetails: Record<Intelligibility, { label: string; icon: string }> = {
    highly_intelligible: { label: 'Highly intelligible', icon: '✓' },
    partially_intelligible: { label: 'Partially intelligible', icon: '◒' },
    unintelligible: { label: 'Unintelligible', icon: '!' },
    not_applicable: { label: 'Not applicable', icon: '–' }
  };

  let { annotations, activeId = null, format, disabled = false, onselect, onremove }: Props = $props();
  let ordered = $derived([...annotations].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs));

  function annotationName(annotation: AnnotationRow): string {
    return annotation.transcription || annotation.id;
  }

  function speakerSlot(annotation: AnnotationRow): number {
    return stableColorSlot(annotation.speakerId ?? 'unassigned-speaker', speakerColorSlots);
  }
</script>

<section aria-label="Saved annotations" class="annotation-table">
  <div class="annotation-list-scroll" data-testid="annotation-list-scroll" role="grid" aria-label="Saved annotations">
    <div class="annotation-list-header" role="row">
      <div role="columnheader">Time</div>
      <div role="columnheader">Speaker</div>
      <div role="columnheader">Transcript</div>
      <div role="columnheader">Tags</div>
      <div role="columnheader">Intelligibility</div>
      <div role="columnheader">Actions</div>
    </div>

    {#each ordered as annotation (annotation.id)}
      {@const status = intelligibilityDetails[annotation.intelligibility]}
      {@const colorSlot = speakerSlot(annotation)}
      <div
        class:active={annotation.id === activeId}
        class="annotation-row"
        data-annotation-id={annotation.id}
        role="row"
      >
        <div class="annotation-time" role="gridcell">{formatTime(annotation.startMs, format)}–{formatTime(annotation.endMs, format)}</div>
        <div class="annotation-speaker" role="gridcell">
          <span class="speaker-rail" data-testid={`speaker-rail-${annotation.id}`} data-color-slot={colorSlot} aria-hidden="true">
            <span class="speaker-dot" data-testid={`speaker-dot-${annotation.id}`} data-color-slot={colorSlot}></span>
          </span>
          <span>{annotation.speaker}</span>
        </div>
        <div class="annotation-transcript" role="gridcell" title={annotation.transcription || 'No transcript'}>
          {annotation.transcription || 'No transcript'}
        </div>
        <div class="annotation-tags" role="gridcell">
          {#if annotation.tags.length}
            {#each annotation.tags as tag (tag.id)}
              <span class="annotation-tag" data-color-slot={stableColorSlot(tag.id, tagColorSlots)}>{tag.label}</span>
            {/each}
          {:else}
            <span class="annotation-none">No tags</span>
          {/if}
        </div>
        <div class="annotation-intelligibility" role="gridcell">
          <span class={`intelligibility intelligibility-${annotation.intelligibility}`} aria-label={`${status.label} status`}>
            <span aria-hidden="true">{status.icon}</span>
            <span>{status.label}</span>
          </span>
        </div>
        <div class="annotation-actions" role="gridcell">
          <button
            type="button"
            aria-current={annotation.id === activeId ? 'true' : undefined}
            aria-label={`Edit annotation ${annotationName(annotation)}`}
            {disabled}
            onclick={() => onselect(annotation.id)}
          >Edit</button>
          <button
            type="button"
            aria-label={`Remove annotation ${annotationName(annotation)}`}
            {disabled}
            onclick={() => onremove(annotation.id)}
          >Remove</button>
        </div>
      </div>
    {/each}
  </div>
</section>
