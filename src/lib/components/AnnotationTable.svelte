<script lang="ts">
  export let annotations: { id: string; startMs: number; endMs: number; transcription: string; speaker: string }[] = [];
  export let activeId: string | null = null;
  export let onselect: (id: string) => void;
  export let onremove: (id: string) => void;

  $: ordered = [...annotations].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
</script>

<section aria-label="Saved annotations" class="annotation-table">
  {#each ordered as annotation}
    <div class:active={annotation.id === activeId} class="annotation-row">
      <button
        type="button"
        aria-current={annotation.id === activeId ? 'true' : undefined}
        aria-label={`Edit annotation ${annotation.transcription || annotation.id}`}
        on:click={() => onselect(annotation.id)}
      >
        <span>{(annotation.startMs / 1000).toFixed(3)}–{(annotation.endMs / 1000).toFixed(3)}</span>
        <span>{annotation.speaker}</span>
        <span>{annotation.transcription || '—'}</span>
      </button>
      <button type="button" aria-label={`Remove annotation ${annotation.transcription || annotation.id}`} on:click={() => onremove(annotation.id)}>Remove</button>
    </div>
  {/each}
</section>
