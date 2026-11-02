<script lang="ts">
  interface Props {
    filename: string | null;
    analysisPercent?: number | null;
    busy?: boolean;
    onopen: () => void;
    onimport: () => void;
    onexport: () => void;
    oncancelanalysis: () => void;
    onshortcuts: () => void;
    onsettings: () => void;
  }

  let {
    filename, analysisPercent = null, busy = false,
    onopen, onimport, onexport, oncancelanalysis, onshortcuts, onsettings
  }: Props = $props();
</script>

<header class="top-bar">
  <div class="brand">
    <svg role="img" aria-label="ScribeLight waveform logo" viewBox="0 0 32 24">
      <path d="M1 12h4l2-7 4 14 4-17 4 20 4-14 3 7h5" />
    </svg>
    <span>ScribeLight</span>
  </div>
  <button type="button" class="ghost" onclick={onopen}>Open audio</button>
  <span class="filename" title={filename ?? undefined}>{filename ?? 'No clip open'}</span>

  {#if analysisPercent !== null}
    <div class="analysis-status">
      <progress aria-label="Waveform analysis progress" aria-valuenow={analysisPercent} max="100" value={analysisPercent}>
        {analysisPercent}%
      </progress>
      <span>Analyzing waveform {analysisPercent}%</span>
      <button type="button" class="ghost" onclick={oncancelanalysis}>Cancel analysis</button>
    </div>
  {/if}

  <div class="top-actions">
    <button type="button" class="ghost" disabled={!filename || busy} onclick={onimport}>Import TSV</button>
    <button type="button" class="ghost" disabled={!filename || busy} onclick={onexport}>Export TSV</button>
    <button type="button" class="ghost icon" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onclick={onshortcuts}>?</button>
    <button type="button" class="ghost" disabled={busy} onclick={onsettings}>Settings</button>
  </div>
</header>
