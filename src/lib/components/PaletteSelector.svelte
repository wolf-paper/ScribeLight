<script lang="ts">
  import { PALETTE_IDS, type PaletteId } from '../theme/palette';

  interface Props {
    value: PaletteId;
    disabled?: boolean;
    onchange: (value: PaletteId) => void;
  }

  const labels: Record<PaletteId, string> = {
    'ion-magenta': 'Ion Magenta',
    'arctic-steel': 'Arctic Steel',
    'ultraviolet-grid': 'Ultraviolet Grid',
    'crimson-scope': 'Crimson Scope'
  };

  const previews: Record<PaletteId, readonly string[]> = {
    'ion-magenta': ['#0B0C19', '#111326', '#17182B', '#22213A', '#EF5BAD'],
    'arctic-steel': ['#0B1015', '#10171E', '#16212B', '#1C2A35', '#38BDF8'],
    'ultraviolet-grid': ['#11091B', '#170D25', '#1E102E', '#2D1843', '#B978F6'],
    'crimson-scope': ['#19090D', '#210C12', '#291017', '#3A1922', '#FF647C']
  };

  let { value, disabled = false, onchange }: Props = $props();
</script>

<fieldset class="palette-selector" {disabled}>
  <legend>Palette</legend>
  <div class="palette-options">
    {#each PALETTE_IDS as paletteId}
      <label class="palette-option">
        <input
          type="radio"
          name="palette"
          value={paletteId}
          checked={value === paletteId}
          onchange={() => onchange(paletteId)}
        />
        <span class="palette-name">{labels[paletteId]}</span>
        <span class="palette-swatches" aria-hidden="true">
          {#each previews[paletteId] as swatch}
            <span class="palette-swatch" style:background={swatch}></span>
          {/each}
        </span>
      </label>
    {/each}
  </div>
</fieldset>

<style>
  .palette-selector {
    display: grid;
    gap: .5rem;
    border: 0;
    margin: 0;
    padding: 0;
  }

  .palette-options {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: .5rem;
  }

  .palette-option {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: .35rem .5rem;
    align-items: center;
    padding: .5rem;
    border: 1px solid var(--color-border);
    background: var(--color-panel);
  }

  .palette-swatches {
    grid-column: 1 / -1;
    display: flex;
    overflow: hidden;
    border: 1px solid var(--color-border);
  }

  .palette-swatch { flex: 1; block-size: .65rem; }
</style>
