<script lang="ts">
  import { PALETTE_IDS, type PaletteId } from '../theme/palette';

  interface Props {
    value: PaletteId;
    disabled?: boolean;
    onchange: (value: PaletteId) => void;
  }

  const labels: Record<PaletteId, string> = {
    'ion-magenta': 'Ion Magenta',
    'neon-ember': 'Neon Ember',
    'mercury-vapor': 'Mercury Vapor',
    'argon-current': 'Argon Current',
    'xenon-arc': 'Xenon Arc',
    'krypton-glow': 'Krypton Glow',
    'sodium-vapor': 'Sodium Vapor',
    'oxygen-pearl': 'Oxygen Pearl'
  };

  const previews: Record<PaletteId, readonly string[]> = {
    'ion-magenta': ['#0B0C19', '#17182B', '#403653', '#EF5BAD', '#71DCE8'],
    'neon-ember': ['#0F0A09', '#1D1210', '#563126', '#FF5A36', '#FFB347'],
    'mercury-vapor': ['#071013', '#0D1D23', '#285567', '#39CFE8', '#98F3FF'],
    'argon-current': ['#0B0A17', '#16132B', '#3B346A', '#7A70FF', '#B5A8FF'],
    'xenon-arc': ['#080D17', '#101A2B', '#29436E', '#4D8DFF', '#73D8FF'],
    'krypton-glow': ['#100A17', '#1C1229', '#4B3164', '#BA68E8', '#E6A3FF'],
    'sodium-vapor': ['#100C0A', '#1E1512', '#573A30', '#FF8E72', '#FFD08A'],
    'oxygen-pearl': ['#090D10', '#12191E', '#344550', '#B8D2DD', '#F1FCFF']
  };

  let { value, disabled = false, onchange }: Props = $props();
</script>

<label class="palette-selector">
  <span>Palette</span>
  <select
    {disabled}
    value={value}
    onchange={(event) => onchange(event.currentTarget.value as PaletteId)}
  >
    {#each PALETTE_IDS as paletteId}
      <option value={paletteId}>{labels[paletteId]}</option>
    {/each}
  </select>
  <span class="palette-swatches" aria-hidden="true">
    {#each previews[value] as swatch}
      <span class="palette-swatch" style:background={swatch}></span>
    {/each}
  </span>
</label>

<style>
  .palette-selector {
    display: grid;
    gap: .35rem;
    max-width: 22rem;
  }

  .palette-selector select { width: 100%; }

  .palette-swatches {
    display: flex;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: .25rem;
  }

  .palette-swatch { flex: 1; block-size: .75rem; }
</style>
