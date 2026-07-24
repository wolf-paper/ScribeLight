# ScribeLight

ScribeLight is a Windows desktop waveform looper and structured transcription annotator for MP3 and WAV clips up to 30 minutes long. Projects keep editable speaker and acoustic-tag labels in ScribeLight's application-data directory; the source audio remains untouched.

## Prerequisites

- [Bun](https://bun.sh/)
- Rust stable with the MSVC target, `rustfmt`, and `clippy`
- Microsoft C++ Build Tools with the Desktop development with C++ workload
- Microsoft Edge WebView2 Runtime (included with current Windows releases)

## Development

Install project dependencies with `bun install`, then start the desktop application with:

```powershell
bun tauri dev
```

## Desktop workspace

ScribeLight opens at 1280x800 with a 1280px minimum width. Its dense desktop layout keeps the title and waveform logo in a compact toolbar, gives the waveform the full window width, and keeps the active transcription editor above a continuously scrollable Saved annotations list beside the Selection inspector without pagination. Saved ranges appear as faint interactive waveform annotations: hovering a saved row or hovering a saved waveform region previews it without mutation, while clicking a row or double-clicking activates it. Inspector Add can begin a fresh draft at the current loop range, while deletion from the Saved annotations list remains destructive. Settings owns project speaker and acoustic-tag labels, multiline TSV export policy, and appearance.

The application-global palette is stored separately from project and TSV data under `scribelight.palette`; when that key is absent, ScribeLight reads the legacy `lightscribe.palette` value for upgrade compatibility. Ion Magenta is the default. The available palettes are Ion Magenta, Neon Ember, Mercury Vapor, Argon Current, Xenon Arc, Krypton Glow, Sodium Vapor, and Oxygen Pearl. The remaining base workspace, palette, interaction, and accessibility contract is recorded in the [ScribeLight UI Rework Design](docs/superpowers/specs/2026-07-19-lightscribe-ui-rework-design.md). The [Transcription and Waveform QoL Design](docs/superpowers/specs/2026-07-21-transcription-waveform-qol-design.md) supersedes the editor, saved-annotation list, and waveform-interaction sections of that UI rework design. The [Waveform Region and Inspector QoL Design](docs/superpowers/specs/2026-07-22-waveform-region-inspector-qol-design.md) supersedes only the passive-region interaction and inspector-action requirements of that QoL design. The original [product specification](docs/superpowers/specs/2026-07-18-lightscribe-design.md) remains authoritative for audio, persistence, and interchange behavior.

## Verification

Run the complete automated matrix from the repository root:

```powershell
bun run verify
bun run test:e2e
```

`verify` runs the Vite-aware unit/component suite, Svelte and TypeScript checks, a production frontend build with browser-fake exclusion inspection, Rust formatting, strict all-target Clippy, and all Rust tests. The browser suite builds a separate test-mode frontend and drives the real Svelte stores and components through a narrow fake native boundary.

Automated native tests prove loop and seek precision in source PCM frames, including end-exclusive WAV loop boundaries and MP3 exact-seek equivalence. They do not prove what audio sounds like; an audible/native-window smoke check remains a manual release step.

## Packaging

Build the Windows application and installers without installing them system-wide:

```powershell
bun tauri build
```

The standalone executable is written below `src-tauri/target/release/`, and Windows bundle artifacts are written below `src-tauri/target/release/bundle/` (including the NSIS installer when that target is enabled).

## Portable TSV format

ScribeLight imports and exports UTF-8 tab-separated files with this exact ten-column header:

```text
start_seconds	end_seconds	event_type	transcription	intelligibility	speaker	overlap	confidence	acoustic_tags	notes
```

Times use decimal seconds with three fractional digits. The `escape` multiline policy writes newlines as `\n` and escapes backslashes, `space` replaces newlines with spaces, and `quoted` uses standard TSV quoting to preserve physical newlines. Speaker and acoustic-tag labels are exported by their current editable project labels, making renamed labels portable without changing the media file.

## Playback and waveform authority

The Rust CPAL/Symphonia playback engine is authoritative for playback position, exact seeking, and loop application in source PCM frames. WaveSurfer receives precomputed min/max peaks and is only the renderer; browser timing never defines native playback position or loop boundaries.

The desktop capability grants Tauri core defaults, the explicit window-destroy operation required after a successful recovery flush, and open/save file dialogs. It does not grant directory enumeration or opener permissions.

The production Content Security Policy permits only bundled UI resources and Tauri's local IPC endpoint. Dynamic inline styles remain enabled because Svelte's timeline geometry and WaveSurfer's shadow-DOM renderer update element styles at runtime; remote network, blob, data, asset, and media sources remain blocked.
