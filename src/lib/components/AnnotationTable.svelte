<script lang="ts">
  interface Row {
    id: string;
    startMs: number;
    endMs: number;
    transcription: string;
    speaker: string;
  }

  interface Props {
    annotations?: Row[];
    activeId?: string | null;
    onselect: (id: string) => void;
    onremove: (id: string) => void;
  }

  let { annotations = [], activeId = null, onselect, onremove }: Props = $props();
  let ordered = $derived([...annotations].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs));
</script>

<section aria-label="Saved annotations" class="annotation-table">
  {#each ordered as annotation (annotation.id)}
    <div class:active={annotation.id === activeId} class="annotation-row">
      <button
        type="button"
        aria-current={annotation.id === activeId ? 'true' : undefined}
        aria-label={`Edit annotation ${annotation.transcription || annotation.id}`}
        onclick={() => onselect(annotation.id)}
      >
        <span>{(annotation.startMs / 1000).toFixed(3)}–{(annotation.endMs / 1000).toFixed(3)}</span>
        <span>{annotation.speaker}</span>
        <span>{annotation.transcription || '—'}</span>
      </button>
      <button type="button" aria-label={`Remove annotation ${annotation.transcription || annotation.id}`} onclick={() => onremove(annotation.id)}>Remove</button>
    </div>
  {/each}
</section>
