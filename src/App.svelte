<script lang="ts">
  let hasAudio = false;
</script>

<svelte:head><title>Lightscribe</title></svelte:head>

<main class="app-shell">
  <header><h1>Lightscribe</h1></header>
  {#if !hasAudio}
    <section class="empty-state" aria-live="polite">
      <p>Open an MP3 or WAV file to begin.</p>
    </section>
  {/if}
</main>
