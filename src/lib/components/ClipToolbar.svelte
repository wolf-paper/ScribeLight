<script lang="ts">
  import type { MultilinePolicy, TimeDisplayFormat } from '../domain/types';

  interface Actions {
    open(): void;
    importTsv(): void;
    togglePlay(): void;
    toggleLoop(): void;
    toggleFormat(): void;
    setMultilinePolicy(value: MultilinePolicy): void;
    exportTsv(): void;
    cancelAnalysis(): void;
    setVolume(value: number): void;
  }

  interface Props {
    filename: string | null;
    playing: boolean;
    loopEnabled: boolean;
    canLoop: boolean;
    format: TimeDisplayFormat;
    multilinePolicy: MultilinePolicy;
    volume?: number;
    analysisPercent?: number | null;
    busy?: boolean;
    settingsBusy?: boolean;
    actions: Actions;
  }

  let {
    filename, playing, loopEnabled, canLoop, format, multilinePolicy, volume = 1,
    analysisPercent = null, busy = false, settingsBusy = false, actions
  }: Props = $props();
</script>

<header class="clip-toolbar">
  <button type="button" onclick={actions.open}>Open audio</button>
  <span class="filename" title={filename ?? undefined}>{filename ?? 'No clip open'}</span>
  <button type="button" disabled={!filename || busy} aria-label={playing ? 'Pause' : 'Play'} onclick={actions.togglePlay}>
    {playing ? 'Pause' : 'Play'}
  </button>
  <button
    type="button"
    class:active={loopEnabled}
    disabled={!filename || busy || (!canLoop && !loopEnabled)}
    aria-pressed={loopEnabled}
    aria-label={loopEnabled ? 'Loop on' : 'Loop off'}
    onclick={actions.toggleLoop}
  >Loop</button>
  <label class="volume-control">
    <span>Volume</span>
    <input
      aria-label="Volume"
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={volume}
      disabled={!filename || busy}
      oninput={(event) => actions.setVolume(+(event.currentTarget as HTMLInputElement).value)}
    />
  </label>
  <button type="button" disabled={!filename || busy} aria-label={format === 'seconds' ? 'Show clock time' : 'Show decimal seconds'} onclick={actions.toggleFormat}>
    {format === 'seconds' ? 'mm:ss.mmm' : 'seconds.mmm'}
  </button>
  <label class="multiline-policy">
    <span>Multiline export policy</span>
    <select
      value={multilinePolicy}
      disabled={!filename || busy || settingsBusy}
      onchange={(event) => actions.setMultilinePolicy((event.currentTarget as HTMLSelectElement).value as MultilinePolicy)}
    >
      <option value="escape">Escape line breaks as \n</option>
      <option value="space">Replace line breaks with spaces</option>
      <option value="quoted">Preserve line breaks in quoted fields</option>
    </select>
  </label>
  <button type="button" disabled={!filename || busy || settingsBusy} onclick={actions.importTsv}>Import TSV</button>
  <button type="button" disabled={!filename || busy || settingsBusy} onclick={actions.exportTsv}>Export TSV</button>
  {#if analysisPercent !== null}
    <progress
      aria-label="Waveform analysis progress"
      aria-valuenow={analysisPercent}
      max="100"
      value={analysisPercent}
    >{analysisPercent}%</progress>
    <span>Analyzing waveform {analysisPercent}%</span>
    <button type="button" onclick={actions.cancelAnalysis}>Cancel analysis</button>
  {/if}
</header>
