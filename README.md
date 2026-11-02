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

## Annotating

The window is one workspace: the timeline (minute:second ruler, range bar, waveform) on top, playback controls under it, the annotation list on the left, and the editor for the open annotation on the right.

- **Moving the playhead:** click the waveform or ruler, drag the ruler or the playhead to scrub, or use ←/→ (50 ms) and Shift+←/→ (1 s). Space plays or pauses from the playhead.
- **Marking a range:** drag across the waveform, press I and O at the playhead while listening, or type start and end times (`1:23.456`, or plain seconds) in the editor. Drag a range's edges to adjust it; L loops it.
- **Adding:** a new range opens as **New annotation**. Type the transcription and press Enter (or **Add annotation**). The editor lists anything Yamabiko still needs before you add it.
- **Editing:** click an annotation in the list or on the waveform to open it. Every change saves immediately; there is no update step. Esc leaves it and starts a new one, Delete removes it, and Ctrl+Z (or **Undo** in the status bar) restores the last deletion.
- **Review:** annotations that Yamabiko would reject are marked **Needs review**. Filter the list to them, and press N / Shift+N to step through them; the editor shows each reason.

Press ? for the full list of shortcuts.

## Yamabiko worksheet TSV

ScribeLight's TSV import and export is the Yamabiko E0 annotation worksheet format, matching `parse_annotation_worksheet` in Yamabiko's `scripts/e0_evidence/annotations.py`:

```text
start_seconds	end_seconds	event_type	japanese	intelligibility	speaker	overlap	confidence	acoustic_tags	notes
```

- UTF-8, one physical row per annotation, no quoting: `"` is always a literal character on import and export.
- Times are milliseconds written as seconds with exactly three decimals. Intelligibility is written as `intelligible`, `partially_intelligible`, `unintelligible`, or `not_applicable`.
- Line breaks typed or pasted into transcription or notes become spaces, and export writes any remaining line break as a space.
- Import also accepts older ScribeLight exports (a `transcription` header and `highly_intelligible`).

Speaker labels must be `speaker_1`, `speaker_2`, …, and acoustic tags must come from Yamabiko's closed vocabulary; new projects start with all 18 tags, and the label managers refuse anything else.

Yamabiko's row rules are checked live: a speaker for speech, all four labels set, transcription for intelligible speech (with at least one letter, kana, kanji, or digit when fully intelligible), no transcription for unintelligible speech or non-speech, overlap matching the `overlap` tag, no `non_speech_control` on speech, and no contradictory tag pairs. A rule violation never blocks saving; the annotation is marked **Needs review** in the list and the editor names each reason. Blank labels in subtitle-seeded review worksheets import as **Not set**. Import status reports how many annotations Yamabiko would still reject, and exporting while any remain asks for confirmation first, then writes them so work is never trapped.

Pass-B coverage-only worksheets, which forbid speech text, are not checked for that policy.

## Playback and waveform authority

The Rust CPAL/Symphonia playback engine is authoritative for playback position, exact seeking, and loop application in source PCM frames. WaveSurfer receives precomputed min/max peaks and is only the renderer; browser timing never defines native playback position or loop boundaries.

The desktop capability grants Tauri core defaults, the explicit window-destroy operation required after a successful recovery flush, and open/save file dialogs. It does not grant directory enumeration or opener permissions.

The production Content Security Policy permits only bundled UI resources and Tauri's local IPC endpoint. Dynamic inline styles remain enabled because Svelte's timeline geometry and WaveSurfer's shadow-DOM renderer update element styles at runtime; remote network, blob, data, asset, and media sources remain blocked.
