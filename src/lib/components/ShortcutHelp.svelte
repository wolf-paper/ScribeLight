<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();
  let dialog: HTMLDialogElement;
  let closeButton: HTMLButtonElement;

  /** `gesture: true` entries describe a mouse action, shown as text rather than as a key. */
  const groups: { title: string; keys: { key: string; action: string; gesture?: true }[] }[] = [
    {
      title: 'Listening',
      keys: [
        { key: 'Space', action: 'Play or pause' },
        { key: '← / →', action: 'Move the playhead 50 ms' },
        { key: 'Shift + ← / →', action: 'Move the playhead 1 s' },
        { key: 'Click waveform or ruler', action: 'Move the playhead there', gesture: true },
        { key: 'Drag the ruler', action: 'Scrub', gesture: true },
        { key: 'L', action: 'Loop the marked range' },
        { key: 'Ctrl + wheel', action: 'Zoom the waveform' }
      ]
    },
    {
      title: 'Marking',
      keys: [
        { key: 'Drag on the waveform', action: 'Mark a new range', gesture: true },
        { key: 'I / O', action: 'Set the start / end to the playhead' },
        { key: 'Drag a range edge', action: 'Adjust the range', gesture: true },
        { key: 'Enter', action: 'In Transcription: add the new annotation' },
        { key: 'Esc', action: 'Leave the annotation and start a new one' }
      ]
    },
    {
      title: 'Moving around',
      keys: [
        { key: '↑ / ↓', action: 'Previous / next annotation' },
        { key: 'N / Shift + N', action: 'Next / previous annotation that needs review' },
        { key: 'Click a saved range', action: 'Open that annotation', gesture: true },
        { key: 'Enter', action: 'Jump to the transcription' },
        { key: 'Delete', action: 'Delete the open annotation' },
        { key: 'Ctrl + Z', action: 'Undo the last delete' }
      ]
    }
  ];

  onMount(() => {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    closeButton.focus();
    return () => {
      if (!dialog.open) return;
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    };
  });
</script>

<div class="modal-backdrop">
  <dialog
    bind:this={dialog}
    class="shortcut-dialog"
    aria-labelledby="shortcut-title"
    oncancel={(event) => { event.preventDefault(); onclose(); }}
    onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onclose(); } }}
  >
    <header class="modal-header">
      <h2 id="shortcut-title">Keyboard shortcuts</h2>
      <button bind:this={closeButton} type="button" class="ghost" onclick={onclose}>Close</button>
    </header>
    <div class="shortcut-groups">
      {#each groups as group (group.title)}
        <section aria-label={group.title}>
          <h3>{group.title}</h3>
          <dl>
            {#each group.keys as { key, action, gesture } (action)}
              <dt>{#if gesture}{key}{:else}<kbd>{key}</kbd>{/if}</dt>
              <dd>{action}</dd>
            {/each}
          </dl>
        </section>
      {/each}
    </div>
  </dialog>
</div>
