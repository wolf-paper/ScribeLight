# Lightscribe Design Specification

**Date:** 2026-07-18  
**Status:** Approved in conversation; pending written-spec review

This document defines Lightscribe's audio, annotation, persistence, and interchange behavior. The approved desktop presentation and workflow are defined by the [Lightscribe UI Rework Design](2026-07-19-lightscribe-ui-rework-design.md), which supersedes the original stacked-dashboard layout and legacy intelligibility vocabulary in this document.

## 1. Product Summary

Lightscribe is a lightweight desktop audio player and annotation workspace for transcriptionists. It displays an MP3 or WAV waveform, lets the annotator create and repeatedly play precise loop selections, and associates each selection with structured transcript metadata. Projects persist locally and annotations export as UTF-8 TSV.

The first release targets audio clips up to 30 minutes. It supports mouse and keyboard operation, overlapping annotations, project-specific speakers and acoustic tags, millisecond time displays, and precise sample-counted looping.

## 2. Goals

- Open local MP3 and WAV files without modifying or copying the source audio.
- Render a zoomable waveform with synchronized rulers and a highlighted loop selection.
- Create, resize, move, and replay loop selections using either the mouse or keyboard.
- Store selection boundaries as integer milliseconds and reproduce audible loop transitions within 1 ms at the decoded PCM boundary.
- Create and update structured annotations linked to loop selections.
- Support overlapping annotations for simultaneous speakers.
- Allow each project to add, rename, and remove speakers and acoustic tags.
- Recover project state and editor drafts after the application closes unexpectedly.
- Import compatible annotation TSV files and export portable UTF-8 TSV.
- Keep waveform analysis and playback memory bounded for recordings up to 30 minutes.

## 3. Non-Goals

- Automatic speech recognition, translation, or subtitle lookup.
- Multi-user collaboration, annotator comparison, or adjudication.
- Editing adjacent project JSON metadata.
- Editing, cutting, transforming, or exporting audio.
- Supporting formats other than MP3 and WAV in the first release.
- Sample-number display in the user interface.
- Enforcing Japanese-only text or another project's editorial policy in the core application.

## 4. Technology and Packaging

- **Desktop shell:** Tauri
- **Frontend:** Svelte with TypeScript
- **Frontend toolchain:** Bun and Vite
- **Waveform rendering and region interaction:** WaveSurfer.js
- **Native playback:** Rust using CPAL for audio-device output and Symphonia for MP3/WAV decoding
- **Project persistence:** Versioned JSON in the Tauri application-data directory
- **Annotation interchange:** UTF-8 TSV

WaveSurfer is a renderer and pointer-interaction surface. It is not the authoritative playback engine or clock. The Rust engine owns playback position, seeking, and loop transitions.

## 5. High-Level Architecture

### 5.1 Frontend units

1. **Application shell**
   - Owns project opening and closing, global errors, and top-level layout.
   - Connects Tauri events and commands to frontend stores.

2. **Audio session controller**
   - Sends load, play, pause, seek, volume, and loop commands to Rust.
   - Receives authoritative position, state, progress, and error events.
   - Keeps the visual playhead interpolated between native position updates without making it authoritative.

3. **Timeline workspace**
   - Renders the top ruler, loop-selection bar, waveform, and bottom ruler.
   - Converts pointer coordinates to integer millisecond selections.
   - Synchronizes region dragging, handles, keyboard markers, rulers, and zoom.

4. **Annotation dashboard**
   - Edits the active selection's structured fields.
   - Provides explicit Add, Update, Clear, and Remove actions.
   - Uses the fixed event, intelligibility, overlap, and confidence vocabularies.

5. **Settings dialog**
   - Owns application appearance, project speaker and acoustic-tag administration, and the project's multiline TSV export policy.
   - Applies one of the four approved application-global palettes without storing the choice in project JSON or TSV.

6. **Annotation list**
   - Lists committed events in chronological order in a continuously scrollable list with no pagination.
   - Loads a row into the selection and editor for replay or editing.
   - Keeps simultaneous overlapping events as separate rows.

7. **Project store**
   - Holds the project configuration, committed annotations, active selection, editor draft, time format, and current annotation identity.
   - Serializes only portable application data, not WaveSurfer or native-engine objects.

### 5.2 Native Rust units

1. **Audio decoder**
   - Uses Symphonia to inspect and decode MP3/WAV files.
   - Seeks before a compressed MP3 target when necessary and discards decoded samples until the exact target frame.

2. **Playback engine**
   - Uses CPAL for the output callback.
   - Feeds a bounded PCM ring buffer from a decoder worker.
   - Tracks position and loop endpoints in decoded PCM frames.
   - Applies state changes without allocating, blocking, or locking unpredictably inside the real-time callback.

3. **Waveform analyzer**
   - Streams through the file and creates cached, downsampled peak data suitable for the supported zoom range.
   - Reports progress and accepts cancellation.
   - Does not retain the complete decoded clip.

4. **Project repository**
   - Reads and atomically writes versioned JSON project records and draft state.
   - Maintains waveform cache identity and invalidation.

5. **TSV service**
   - Parses explicit user-selected TSV files.
   - Maps known portable aliases into the internal model.
   - Validates and atomically writes exports.

## 6. Playback Precision Contract

### 6.1 Stored boundaries

- The canonical UI and project representation is integer milliseconds.
- A boundary is converted to the nearest decoded PCM frame using the source sample rate.
- The displayed time always reflects the stored integer millisecond value, not a rounded visual pixel position.

### 6.2 Audible loop boundary

For a loop `[startMs, endMs)`:

- The final output frame before a wrap must be within 1 ms of `endMs`.
- The first source frame after the wrap must be within 1 ms of `startMs`.
- The PCM stream must not insert or duplicate more than 1 ms of audio at the wrap.
- The engine must prebuffer the restart data before reaching the end boundary.

This contract is measured in the PCM stream supplied to the operating-system audio device. Hardware and operating-system output latency is excluded because it delays the entire signal rather than changing the relative loop boundary.

MP3 boundaries may fall inside compressed frames. The decoder must seek to an earlier decodable point, decode forward, discard samples before the requested boundary, and retain the exact restart data. A coarse decoder seek alone does not satisfy the contract.

### 6.3 Visual timing

The native frame counter is authoritative. The Svelte playhead may interpolate between native updates for smoothness. A delayed animation frame must never change stored boundaries or native loop timing.

## 7. Interface Design

The interface follows the [Lightscribe UI Rework Design](2026-07-19-lightscribe-ui-rework-design.md). The Tauri window opens at 1280x800 with a 1280px minimum width and no document-level horizontal overflow. A compact title/logo toolbar sits above the full-width waveform timeline; the lower workspace keeps the continuously scrollable Saved annotations list on the left and the Selection inspector on the right.

Ion Magenta is the default palette. Settings also offers Arctic Steel, Ultraviolet Grid, and Crimson Scope. Palette selection applies across the application, persists under `lightscribe.palette`, and remains independent of project JSON and TSV data.

### 7.1 Clip toolbar

The toolbar contains:

- Open Audio
- Open Project or Import TSV
- Current filename and duration
- Play/Pause
- Loop enabled toggle
- Volume
- Time-format toggle
- Import TSV
- Export TSV
- Settings

Supported display formats are:

- Seconds with milliseconds: `72.345`
- Minutes, seconds, and milliseconds: `01:12.345`

TSV export always uses decimal seconds with exactly three fractional digits, regardless of the display format.

### 7.2 Timeline workspace

The vertical order is fixed:

1. Top time ruler
2. Draggable loop-selection bar
3. Waveform with the selected region highlighted
4. Bottom time ruler

The selection can be created by dragging across the waveform. Either boundary can be resized, and the entire selection bar can be dragged without changing its duration. Every interaction updates one canonical `{ startMs, endMs }` selection state. The selection is clamped to the clip and must satisfy `endMs > startMs` before playback or annotation commit.

### 7.3 Zoom

- `Ctrl+wheel up` zooms in when the pointer is over the waveform.
- `Ctrl+wheel down` zooms out.
- Zoom is centered on the audio time beneath the pointer.
- The top ruler, selection bar, waveform, bottom ruler, region highlight, and playhead share the same horizontal viewport.
- When zoomed beyond the viewport, horizontal scrolling becomes available.
- The minimum zoom fits the complete clip. Maximum zoom must make individual millisecond boundaries selectable without requiring a full-resolution decoded audio buffer.
- The gesture prevents browser/page zoom while the pointer is over the timeline.

### 7.4 Keyboard interaction

- `Space`: play or pause
- `I`: set selection start at the native playhead
- `O`: set selection end at the native playhead
- `L`: enable or disable looping
- `Left` / `Right`: seek backward or forward 50 ms
- `Shift+Left` / `Shift+Right`: seek backward or forward one second
- `Enter`: add the draft as a new annotation or update the selected annotation
- `Shift+Enter`: insert a line break in a multiline transcription or notes editor

An Enter key used to accept an active IME composition must never submit the annotation. Shortcut handling must check composition state. Native select menus and modal dialogs retain their standard keyboard behavior. General playback shortcuts do not fire while the user is entering text, except for the specified Enter and Shift+Enter editor behavior.

### 7.5 Annotation dashboard

The dashboard shows the exact selection start and end, then provides:

- Event type
- Speaker
- Transcription
- Intelligibility
- Overlap
- Confidence
- Acoustic tags
- Notes
- Add or Update
- Clear

Defaults are optimized for speech annotation while remaining portable.

Speaker and acoustic-tag management, palette selection, and the multiline TSV export policy are owned by Settings rather than the selection inspector. The complete inspector, Settings, list, and accessibility contracts are specified in the [UI rework design](2026-07-19-lightscribe-ui-rework-design.md).

## 8. Annotation and Project Model

### 8.1 Project

```text
Project {
  schemaVersion
  audioIdentity
  displayFormat
  speakers[]
  acousticTags[]
  annotations[]
  draft
  activeAnnotationId?
  activeSelection?
  exportSettings
}
```

`audioIdentity` contains the canonical path, size, modification time, duration, sample rate, and channel count. The canonical path identifies the project record. Size and modification time invalidate cached audio-derived data and cause a user-visible warning if the source changed.

### 8.2 Annotation

```text
Annotation {
  id
  startMs
  endMs
  eventType
  transcription
  intelligibility
  speakerId?
  overlap
  confidence
  acousticTagIds[]
  notes
  createdAt
  updatedAt
}
```

Times are integer milliseconds. Speaker and tag references use stable internal IDs so renaming a label immediately affects all exports without rewriting every annotation. `speakerId` is required for speech and null for non-speech; a null non-speech speaker exports as the reserved label `none`.

### 8.3 Controlled values

Initial event types:

- `speech`
- `non_speech`

Initial intelligibility values:

- `highly_intelligible`
- `partially_intelligible`
- `unintelligible`
- `not_applicable`

Legacy project and TSV values of `intelligible` are accepted and normalized to `highly_intelligible`; subsequent saves and exports use only the canonical value. See [Intelligibility Values in the UI rework design](2026-07-19-lightscribe-ui-rework-design.md#intelligibility-values).

Overlap values:

- `none`
- `overlap`

Confidence values:

- `high`
- `medium`
- `low`

These four controlled lists are fixed in the first release. Speaker labels and acoustic tags are project-configurable.

### 8.4 Speaker management

- New projects start with `speaker_1`, `speaker_2`, and `speaker_3`.
- Users can add and rename speakers.
- An unused speaker can be removed directly.
- A referenced speaker can be removed only after its annotations are reassigned.
- `none` is reserved for non-speech events and is not an editable speaker.
- The speaker selector is disabled and cleared when an annotation changes to `non_speech`.

### 8.5 Acoustic-tag management

New projects start with:

```text
quiet_dialogue
loud_dialogue
high_f0_nonmodal
overlap
music
effects_noise
music_effects_noise
rapid_turns
short_acknowledgements
long_endpoint
non_speech_control
background_speech
singing
laugh
breath
incomplete_word
```

- Users can add, rename, and remove tags.
- Renaming a tag updates its label everywhere through its stable ID.
- Removing an unused tag is immediate.
- Removing a referenced tag requires confirmation and removes that reference from affected annotations.
- An annotation can select any number of tags.

## 9. Annotation Workflow

1. The user opens an MP3 or WAV file.
2. Lightscribe restores the matching project and peak cache, if present.
3. Otherwise, peak generation begins in the background and reports progress.
4. The user listens through the native engine and creates a selection with the mouse or keyboard.
5. The selection bar, waveform region, rulers, and dashboard times update together.
6. The user fills the structured annotation fields.
7. Enter or Add commits a new annotation. If an existing annotation is active, Enter or Update replaces that annotation while preserving its ID and creation time.
8. The committed project is atomically persisted.
9. Selecting a table row restores its selection and fields for replay or editing.
10. Export TSV validates and writes the current committed annotation list.

Draft fields and the active selection are saved with a short debounce for crash recovery. They do not become committed annotations until Add or Update is invoked.

## 10. Persistence and File Handling

- Project and draft data live in the platform-specific Lightscribe application-data directory.
- Waveform peaks live in a separate cache and may be regenerated safely.
- No database is required for the first release.
- The original audio is never modified or copied.
- Lightscribe never automatically opens or edits adjacent JSON files.
- Lightscribe does not scan for alternate annotator worksheets. TSV import is always an explicit user action.
- Project writes use a temporary file, flush, and atomic replacement where supported.
- A failed save leaves the last valid project record intact and keeps the unsaved state in memory.
- A changed source audio file invalidates its peak cache and requires confirmation before continuing with its existing annotations.

## 11. TSV Import and Export

### 11.1 Portable export columns

Columns are written in this exact order:

```text
start_seconds
end_seconds
event_type
transcription
intelligibility
speaker
overlap
confidence
acoustic_tags
notes
```

### 11.2 Formatting

- Encoding is UTF-8.
- The delimiter is a tab.
- Times use decimal seconds with exactly three fractional digits.
- Rows are ordered by start time, then end time, then creation order.
- Overlapping rows remain separate.
- Acoustic tags are joined with semicolons and no spaces.
- Speaker and tag exports use their current project labels.
- Tabs inside text fields are rejected before export.

### 11.3 Multiline handling

Each project selects one export policy in Settings:

1. Replace line breaks with the literal sequence `\n`.
2. Replace line breaks with spaces.
3. Preserve actual line breaks in quoted multiline fields.

The first policy is the portable default because it retains the distinction without creating physical multiline TSV records. It escapes literal backslashes before encoding line breaks so export and import can be reversed when the same policy is selected. The application preserves actual line breaks internally regardless of export policy.

### 11.4 Import aliases and discovery

- `transcription` maps directly to the internal transcription field.
- `japanese` is accepted as an alias for `transcription`.
- Imported speaker labels not present in the project are added to the speaker configuration.
- The reserved imported speaker label `none` maps to a null speaker on a non-speech annotation and is never added to the editable speaker configuration.
- Imported acoustic tags not present in the project are added to the tag configuration.
- Acoustic tags split on semicolons.
- Imported times are normalized to integer milliseconds.
- Missing, duplicated, or structurally incompatible columns produce an error before the current project changes.

The generic export is intentionally portable rather than automatically conforming to every downstream project's exact worksheet schema. Project-specific renaming or policy enforcement can be added later as explicit export profiles.

## 12. Validation

Structural errors block Add/Update or export as appropriate:

- Start and end must be finite integer milliseconds.
- Start must be at or after zero.
- End must be greater than start.
- End must not exceed the source duration.
- Required controlled fields must contain supported values.
- A speech annotation's referenced speaker and every referenced tag must exist.
- Text fields must not contain tab characters.

Initial annotation rules derived from the target workflow:

- A `speech` annotation requires intelligibility, speaker, overlap, and confidence.
- Highly or partially intelligible speech requires transcription text.
- Unintelligible speech may have blank transcription.
- A `non_speech` annotation defaults to blank transcription, `not_applicable` intelligibility, and the reserved `none` speaker.

Project-specific editorial rules, such as Japanese-only transcription or a fixed four-minute time range, remain guidance rather than hard-coded core restrictions.

## 13. Error Handling

- Unsupported, malformed, or unreadable audio produces an actionable error and leaves the existing project open.
- Decode or audio-device failure stops playback safely and preserves annotations.
- Peak-generation failure does not prevent annotation from being recovered or exported; the user can retry analysis.
- A malformed TSV is parsed into a temporary result and cannot partially replace the current project.
- Validation errors identify the affected annotation and field.
- Persistence failures remain visible until a later successful save.
- Removing referenced speakers or tags requires the specified reassignment or confirmation flow.

## 14. Performance Requirements

- Support MP3 and WAV recordings up to 30 minutes.
- Do not hold the entire decoded recording in frontend memory.
- Keep playback memory bounded with a decoder worker and PCM ring buffer.
- Do not allocate, perform file I/O, decode, or acquire an unbounded lock in the CPAL callback.
- Keep pointer selection, dragging, scrolling, and zoom visually smooth during playback and analysis.
- Cache peak data so reopening an unchanged clip does not decode it again.
- Allow peak generation to run without blocking annotation UI and allow cancellation.
- Meet the playback precision contract in Section 6 for both WAV and MP3 fixtures.

## 15. Verification Strategy

### 15.1 Frontend unit and component tests

- Integer millisecond conversion and both display formats
- Selection creation, resize, move, clamp, and synchronization
- Pointer-centered Ctrl+wheel zoom and shared timeline viewport
- Keyboard seeking and loop controls
- Enter submission, Shift+Enter line breaks, and IME composition handling
- Add versus Update identity behavior
- Speaker and acoustic-tag add, rename, remove, confirmation, and reassignment
- Overlapping annotations and chronological table ordering
- Conditional speech and non-speech validation
- TSV import aliasing and field discovery
- All multiline export policies
- TSV import/export round trips with Japanese text

### 15.2 Rust unit and integration tests

- MP3 and WAV probing and decoding
- Millisecond-to-frame conversion at multiple sample rates
- Exact decoded-frame trimming after MP3 seeks
- Ring-buffer underflow and recovery behavior
- Sample-counted A/B wrap behavior
- One-millisecond precision contract measured on emitted PCM
- Peak generation, progress, cancellation, and cache invalidation
- Project serialization migrations and atomic replacement
- Malformed audio and TSV handling

### 15.3 Desktop workflow smoke test

Using packaged builds and small committed fixtures:

1. Open audio.
2. Generate and zoom the waveform.
3. Create and loop a selection using mouse and keyboard.
4. Add two overlapping annotations with different speakers and tags.
5. Rename a speaker and tag and verify propagation.
6. Close and reopen the application and verify recovery.
7. Update an annotation.
8. Export TSV and reopen it to verify ten columns, UTF-8 text, times, tags, and multiline policy.

## 16. Completion Criteria

The first release is complete when:

- All goal behaviors work in a packaged Tauri application.
- MP3 and WAV fixtures meet the 1 ms PCM loop-boundary contract.
- A 30-minute fixture plays and renders a waveform with bounded memory.
- The complete desktop smoke workflow passes.
- Automated tests cover the timing, annotation, persistence, and interchange rules above.
- The application does not read prohibited adjacent metadata or alter source audio.
