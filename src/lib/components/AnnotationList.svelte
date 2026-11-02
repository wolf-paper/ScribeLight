<script lang="ts">
  import { tick } from 'svelte';
  import { formatDuration, formatTime } from '../domain/time';
  import type { Intelligibility } from '../domain/types';
  import { stableColorSlot } from '../theme/palette';
  import SegmentedControl from './SegmentedControl.svelte';

  export interface AnnotationRow {
    id: string;
    startMs: number;
    endMs: number;
    speakerId: string | null;
    speaker: string;
    transcription: string;
    tags: { id: string; label: string }[];
    intelligibility: Intelligibility | null;
    /** Reasons Yamabiko's worksheet import would reject this row. */
    problems: string[];
  }

  interface Props {
    annotations: AnnotationRow[];
    activeId?: string | null;
    disabled?: boolean;
    onselect: (id: string) => void;
    onpreview?: (id: string | null) => void;
    onreview: (direction: 1 | -1) => void;
  }

  const visibleTagCount = 2;
  const intelligibilityLabels: Record<Intelligibility, string> = {
    highly_intelligible: 'Intelligible',
    partially_intelligible: 'Partly intelligible',
    unintelligible: 'Unintelligible',
    not_applicable: 'Not applicable'
  };

  let { annotations, activeId = null, disabled = false, onselect, onpreview, onreview }: Props = $props();
  let filter = $state<'all' | 'review'>('all');
  let scroller: HTMLDivElement;
  let pointerPreviewId: string | null = null;
  let focusPreviewId: string | null = null;
  let publishedPreviewId: string | null = null;

  const ordered = $derived([...annotations].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs));
  const reviewCount = $derived(ordered.filter((row) => row.problems.length).length);
  const visible = $derived(filter === 'review' ? ordered.filter((row) => row.problems.length || row.id === activeId) : ordered);

  $effect(() => {
    if (reviewCount === 0 && filter === 'review') filter = 'all';
  });

  $effect(() => {
    const id = activeId;
    if (!id) return;
    void tick().then(() => {
      scroller?.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(id)}"]`)?.scrollIntoView?.({ block: 'nearest' });
    });
  });

  $effect(() => {
    if (!disabled) return;
    pointerPreviewId = null;
    focusPreviewId = null;
    publishPreview();
  });

  function publishPreview(): void {
    const next = disabled ? null : pointerPreviewId ?? focusPreviewId;
    if (next === publishedPreviewId) return;
    publishedPreviewId = next;
    onpreview?.(next);
  }

  function relatedAnnotationId(event: PointerEvent | FocusEvent): string | null {
    if (!(event.relatedTarget instanceof Element)) return null;
    return event.relatedTarget.closest<HTMLElement>('.annotation-row')?.dataset.annotationId ?? null;
  }

  function rowKeydown(event: KeyboardEvent, index: number): void {
    if (disabled || event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onselect(visible[index].id);
      return;
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    const next = visible[index + step];
    if (!step || !next) return;
    event.preventDefault();
    onselect(next.id);
    void tick().then(() => scroller?.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(next.id)}"]`)?.focus());
  }
</script>

<section class="annotation-list" aria-labelledby="annotation-list-title">
  <header class="list-header">
    <h2 id="annotation-list-title">Annotations <span class="count">{ordered.length}</span></h2>
    {#if reviewCount}
      <SegmentedControl
        label="Show annotations"
        value={filter}
        {disabled}
        options={[
          { value: 'all', label: `All ${ordered.length}` },
          { value: 'review', label: `Needs review ${reviewCount}` }
        ]}
        onchange={(value) => filter = value}
      />
      <div class="review-nav">
        <button type="button" class="ghost" {disabled} title="Previous annotation that needs review (Shift+N)" aria-label="Previous needing review" onclick={() => onreview(-1)}>‹</button>
        <button type="button" class="ghost" {disabled} title="Next annotation that needs review (N)" onclick={() => onreview(1)}>Next to review <kbd>N</kbd></button>
      </div>
    {:else if ordered.length}
      <p class="list-clear">Ready for Yamabiko</p>
    {/if}
  </header>

  <div bind:this={scroller} class="list-scroll" role="grid" aria-label="Saved annotations" aria-rowcount={visible.length + 1}>
    <div class="list-columns" role="row">
      <div role="columnheader">Start</div>
      <div role="columnheader">Speaker</div>
      <div role="columnheader">Transcription</div>
      <div role="columnheader">Tags</div>
      <div role="columnheader">Status</div>
    </div>
    {#each visible as row, index (row.id)}
      {@const colorSlot = stableColorSlot(row.speakerId ?? 'unassigned-speaker', 5)}
      <div
        class="annotation-row"
        class:active={row.id === activeId}
        class:needs-review={row.problems.length > 0}
        data-annotation-id={row.id}
        role="row"
        tabindex={disabled ? undefined : row.id === activeId || (!activeId && index === 0) ? 0 : -1}
        aria-selected={row.id === activeId}
        aria-disabled={disabled ? 'true' : undefined}
        aria-label={`Annotation at ${formatTime(row.startMs)}${row.transcription ? `: ${row.transcription}` : ''}`}
        onclick={() => { if (!disabled) onselect(row.id); }}
        onkeydown={(event) => rowKeydown(event, index)}
        onpointerenter={() => { pointerPreviewId = row.id; publishPreview(); }}
        onpointerleave={(event) => { pointerPreviewId = relatedAnnotationId(event); publishPreview(); }}
        onfocusin={() => { focusPreviewId = row.id; publishPreview(); }}
        onfocusout={(event) => { focusPreviewId = relatedAnnotationId(event); publishPreview(); }}
      >
        <div role="gridcell" class="cell-time">
          <span class="num">{formatTime(row.startMs)}</span>
          <span class="muted num">{formatDuration(row.endMs - row.startMs)}</span>
        </div>
        <div role="gridcell" class="cell-speaker">
          <span class="speaker-dot" data-color-slot={colorSlot} class:unset={!row.speakerId} aria-hidden="true"></span>
          <span class:muted={!row.speakerId}>{row.speaker}</span>
        </div>
        <div role="gridcell" class="cell-text" class:muted={!row.transcription} title={row.transcription || undefined}>
          {row.transcription || '—'}
        </div>
        <div role="gridcell" class="cell-tags">
          {#each row.tags.slice(0, visibleTagCount) as tag (tag.id)}
            <span class="tag" data-color-slot={stableColorSlot(tag.id, 5)}>{tag.label}</span>
          {/each}
          {#if row.tags.length > visibleTagCount}
            <span class="tag more" title={row.tags.slice(visibleTagCount).map((tag) => tag.label).join(', ')}>+{row.tags.length - visibleTagCount}</span>
          {/if}
        </div>
        <div role="gridcell" class="cell-status">
          {#if row.problems.length}
            <span class="review-flag" title={row.problems.join('\n')}>Needs review</span>
          {:else}
            <span class="muted">{row.intelligibility ? intelligibilityLabels[row.intelligibility] : '—'}</span>
          {/if}
        </div>
      </div>
    {:else}
      <div class="list-empty" role="row">
        <span role="gridcell">No annotations yet. Drag across the waveform to mark a range, then add it.</span>
      </div>
    {/each}
  </div>
</section>
