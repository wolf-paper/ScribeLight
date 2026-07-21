# Transcription and Waveform QoL Design

## Summary

Lightscribe will move transcription entry out of the Selection inspector and into a dedicated `ActiveTextEditor.svelte` panel above the continuous saved-annotation list. Saved annotations will also appear as faint, non-interactive regions on the waveform. Hovering or keyboard-focusing a saved row will emphasize its waveform region without changing application state, while clicking the row will activate that annotation in place of the current Edit button.

All work will be performed in the primary checkout at `C:\Users\squnk\source\repos\wolf-paper\lightscribe`. The change is frontend-only and must preserve the Rust playback engine, 1 ms boundary model, loop behavior, TSV format, project persistence schema, palette selection, and 1280 px minimum-width layout.

## Goals

- Give transcription text more horizontal space and keep it visually adjacent to saved transcriptions.
- Make saved annotation coverage and overlap visible directly on the waveform.
- Connect list browsing to the waveform through visual-only hover feedback.
- Make row activation the primary editing interaction and remove the redundant Edit button.
- Preserve keyboard accessibility and the existing Enter, Shift+Enter, and IME input contract.

## Non-goals

- Changing playback, looping, seeking, zoom math, or audio analysis.
- Adding waveform text labels, speaker-specific region colors, filtering, searching, pagination, or automatic scrolling.
- Changing annotation, project, or TSV schemas.
- Moving inspector fields other than the Transcription textarea.
- Making saved or hover regions draggable, resizable, clickable, or otherwise interactive.

## Layout and Components

The lower workspace retains its existing list/inspector split. Its left side becomes an annotation column with two rows:

1. A compact `ActiveTextEditor.svelte` panel.
2. The existing continuously scrollable `AnnotationTable.svelte` filling the remaining height.

`ActiveTextEditor.svelte` owns only the Transcription field presentation and keyboard behavior. It reads the current project draft from `ProjectStore`, patches `draft.transcription` on input, and submits the draft on plain Enter. Shift+Enter inserts a newline, and composing Enter events are ignored. It does not autofocus when another annotation is activated. Add/Update, Remove, Clear, boundary controls, speaker, event type, intelligibility, overlap, confidence, acoustic tags, and Notes remain in `AnnotationDashboard.svelte`.

The editor is labelled `Transcription`. It displays the current draft regardless of whether the draft represents a new selection or an active saved annotation. Clearing or removing the active annotation updates it through the existing store state.

## Annotation List Interaction

`AnnotationTable.svelte` makes each saved-annotation row directly activatable:

- A primary-button row click calls `onselect(annotation.id)`.
- Enter or Space on a keyboard-focused row performs the same activation.
- Pointer hover and keyboard focus report the row ID through a visual-preview callback.
- Pointer leave and focus leaving the row clear that preview.
- The Edit button is removed.
- The Remove button remains, stops click propagation, and does not activate the annotation before removal.
- Disabled rows cannot activate, preview, or remove annotations.
- Active-row styling and `aria-current` semantics move from the Edit button to the row.

Hover and focus preview are presentation-only. They must not call `ProjectStore.selectAnnotation`, change the draft or loop, seek playback, modify persistence, or emit waveform selection events. Clicking a row continues to use the existing `ProjectStore.selectAnnotation` behavior, which loads the saved draft and makes its boundaries the active loop selection.

The table combines pointer and keyboard preview sources: pointer hover takes precedence, and clearing one source does not clear the preview while the other still targets a row. Moving directly between rows updates the preview without an intermediate state mutation outside the table.

## Waveform Region Architecture

The existing WaveSurfer Regions plugin remains the sole waveform-overlay implementation. The adapter will manage three visual region classes:

1. **Passive saved regions:** one stable, faint region per saved annotation.
2. **Canonical selection region:** the existing strong, editable loop region.
3. **Transient preview region:** at most one stronger, non-interactive region representing the hovered or focused row.

The adapter interface gains methods for synchronizing annotation summaries and the current preview ID. Annotation summaries contain only stable ID, `startMs`, and `endMs`. `App.svelte` derives this list from project annotations, owns the ephemeral preview ID, and passes both through `TimelineWorkspace.svelte` and `WaveformView.svelte` to the adapter.

Passive regions are keyed by stable annotation ID and diffed in place. Text, speaker, tag, and other metadata edits do not recreate a region. Boundary edits update the existing region. Removed annotations remove their region. A preview is cleared when its annotation disappears. Replacing peak data recreates the WaveSurfer adapter and immediately reapplies the latest selection, annotation list, preview, playhead, and zoom state.

All programmatically managed saved and preview regions use `drag: false` and `resize: false`. Their rendered elements do not accept pointer events, so they cannot block the canonical handles or drag-to-select surface. They never become the canonical selection and never invoke the adapter's `onchange` callback. User drag-created regions continue to become the canonical selection through the existing path. Layering keeps passive regions beneath the active selection and draws the transient preview distinctly enough to remain visible over overlapping annotations. Hovering the active row may brighten the same interval but does not alter its boundaries.

## Styling and Palettes

Two semantic palette tokens define saved-region and preview-region colors. Every existing palette supplies both values. Passive regions use a deliberately low-opacity accent wash so dense annotation coverage remains readable without overpowering the waveform. The preview region uses a stronger accent wash. The canonical selection retains its current boundary and selection treatment.

The annotation column uses a bounded, content-sized editor row over a `minmax(0, 1fr)` list row so the saved list remains the primary vertical consumer and continues scrolling rather than paginating. Row hover, focus-visible, active, and disabled states remain distinguishable without relying on color alone. The layout preserves the current relative sizing and 1280 px minimum-width contract.

## State and Edge Cases

- With no annotations, no passive or preview regions are rendered.
- A new unsaved draft is represented only by the canonical selection.
- Overlapping annotations render as overlapping faint regions; the preview is visually strongest and the editable selection remains identifiable.
- Selecting, clearing, updating, or removing an annotation uses existing store persistence and error handling.
- Removing the currently previewed annotation clears the preview safely.
- Switching palettes updates passive, preview, waveform, playhead, and canonical selection colors in place without recreating WaveSurfer.
- Destroying the adapter removes all managed regions, listeners, observers, and WaveSurfer resources idempotently.
- Zoom and horizontal scrolling require no special region geometry because WaveSurfer regions use the same time coordinate system as the waveform.

## Verification

Test-first coverage will be added for:

- `ActiveTextEditor.svelte` input binding, plain Enter submission, Shift+Enter newline behavior, IME composition safety, disabled behavior, and project-state updates.
- `AnnotationDashboard.svelte` no longer rendering the Transcription textarea while retaining the remaining controls and actions.
- `AnnotationTable.svelte` pointer preview, focus preview, row click, Enter/Space activation, active semantics, disabled behavior, and Remove propagation isolation.
- `WaveformView.svelte` and `TimelineWorkspace.svelte` forwarding annotation and preview state.
- The WaveSurfer adapter synchronizing passive regions by ID, updating boundaries, removing stale regions, rendering and clearing one preview, preventing passive callbacks, preserving the editable selection, switching palettes in place, replacing peaks safely, and cleaning up.
- `App.svelte` composing the editor/list/inspector layout and connecting visual preview without mutating project state.
- An end-to-end story that saves overlapping annotations, verifies persistent waveform highlights, previews one from the list without changing the active loop, then clicks it and confirms activation.

Per the project's established development constraint, each task will prepare tests first and execute its focused red/green gate immediately before its commit. The final branch gate will run the complete frontend suite, Svelte checks, production bundle assertion, Rust formatting/Clippy/tests, end-to-end suite, and packaged Tauri build before completion.
