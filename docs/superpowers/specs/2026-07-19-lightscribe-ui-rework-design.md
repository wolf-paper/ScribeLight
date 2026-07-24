# ScribeLight UI Rework Design

## Summary

ScribeLight will use a dense, review-oriented desktop workspace optimized for a 1280px minimum window width. The approved layout combines the annotation-list and right-inspector structure from mockup Option 2 with the title bar, waveform logo, toolbar, and waveform treatment from Option 1. Ion Magenta is the default visual theme, and Settings offers the eight current palettes: Ion Magenta, Neon Ember, Mercury Vapor, Argon Current, Xenon Arc, Krypton Glow, Sodium Vapor, and Oxygen Pearl.

This rework is presentation and workflow work. The Rust playback engine, waveform analysis, millisecond loop boundaries, Ctrl+wheel zoom behavior, project recovery guarantees, and TSV safety rules remain unchanged except for the explicit intelligibility-token migration described below.

## Desktop Layout

The Tauri window opens at 1280x800 and has a 1280px minimum width. Layout dimensions above that minimum use relative units, `minmax()`, and `clamp()` so the waveform, list, and inspector grow proportionally.

The application is divided into three vertical bands:

1. A compact application toolbar containing the ScribeLight waveform mark and title, Open Audio, the current filename, Play/Pause, Loop, volume, the time-format toggle, Import TSV, Export TSV, and Settings.
2. A full-width timeline with top ruler, loop-selection bar, waveform, bottom ruler, and a restrained `Ctrl + wheel to zoom` hint. The waveform occupies roughly one third of the usable window height and retains its existing horizontal-scroll and pointer-centered zoom behavior.
3. A lower workspace using `minmax(0, 1.8fr) minmax(22rem, 1fr)`: Saved annotations on the left and Selection inspector on the right.

Analysis progress and errors appear outside the primary toolbar flow so they cannot cause control clipping. The UI must not create horizontal overflow at the configured 1280px minimum.

## Saved Annotation List

Saved annotations are presented as a fixed-height, continuously scrollable list. There is no pagination. Its header remains visible while rows scroll, and the list preserves its scroll position when an annotation is selected, edited, or updated.

Rows are sorted by start time and show:

- start and end time;
- speaker;
- transcription preview;
- acoustic-tag chips;
- intelligibility status;
- edit and remove actions.

Selecting a row loads it into the inspector and updates the waveform selection. The selected row receives a restrained theme selection background and outline. Speaker color is limited to a narrow leading rail, a dot, and optional chip border so the table does not become visually noisy. A standard Svelte keyed list is sufficient for the first release; virtualization is deferred until measured annotation counts show a need.

## Selection Inspector

The inspector edits either the current loop selection or the active saved annotation. Its body scrolls independently when vertical space is constrained, while its Add/Update action remains reachable.

It contains:

- editable integer-millisecond Start and End inputs plus the formatted duration;
- Speaker and Event type selectors;
- a Transcription textarea;
- Intelligibility, Overlap, and Confidence selectors;
- a searchable Acoustic tags multi-select;
- Notes;
- Add annotation or Update annotation, Clear, and Remove where applicable.

Plain Enter in Transcription or Notes adds or updates the annotation. Shift+Enter inserts a line break. IME composition must never submit. Boundary inputs retain atomic validation: the waveform and active loop update only when both values form a valid, ordered, in-bounds whole-millisecond range.

The acoustic-tag control opens a styled listbox with search, keyboard navigation, checkmarks, and a custom scrollbar. Selected tags appear as removable colored chips. It must remain usable without a mouse and expose its expanded state, active option, and selected values to assistive technology.

## Settings and Label Administration

The toolbar Settings button opens a modal dialog. The dialog contains three sections:

- Appearance: palette selection.
- Project labels: separate Speakers and Acoustic tags panels for add, rename, remove, speaker reassignment, and referenced-tag removal confirmation.
- Export: multiline TSV policy.

This removes all speaker and acoustic-tag administration from the inspector. Existing stable-ID, uniqueness, reserved-label, reassignment, and confirmation rules remain unchanged.

Palette selection applies immediately and persists as an application preference under the local-storage key `scribelight.palette`. If that key is absent, ScribeLight reads `lightscribe.palette` only for upgrade compatibility; future writes use only `scribelight.palette`. Palette selection is not written into an audio project or TSV. Missing, unavailable, or invalid stored values fall back to `ion-magenta`; storage failures must not prevent the application from running. The active palette is applied to the document root before normal interaction so dialogs, scrollbars, and the body use the same theme.

## Palette System

Components consume semantic CSS custom properties rather than palette literals. At minimum the system defines canvas, toolbar, panel, raised/input, border, primary text, secondary text, accent, waveform, active waveform, selection wash, loop boundary, playhead, focus, scrollbar track, and scrollbar thumb tokens.

Ion Magenta is the default and uses the original hybrid values, including the fully saturated solid accent. The current palette set is Ion Magenta, Neon Ember, Mercury Vapor, Argon Current, Xenon Arc, Krypton Glow, Sodium Vapor, and Oxygen Pearl. The later muted-button experiment is not used.

Speaker colors use the shared ordered set `#58D7E8`, `#F0B36A`, `#9B9BFF`, `#64D7A5`, and `#F28BC0`. Acoustic tags use low-opacity cyan, violet, rose, amber, and mint fills. A stable ID-based color function ensures that a speaker or tag retains its color across rows, dropdowns, chips, renames, and sessions.

Intelligibility colors are semantic rather than palette-specific: unintelligible uses coral red, partially intelligible uses amber, highly intelligible uses green, and not applicable uses cool gray. Every status includes text and an icon or shape; meaning never depends on color alone.

## Intelligibility Values

Intelligibility is a fixed controlled vocabulary and is not editable in Settings. Canonical stored and TSV values are:

- `unintelligible`
- `partially_intelligible`
- `highly_intelligible`
- `not_applicable`

The UI displays human-readable labels with spaces and sentence capitalization. Existing projects and imported TSV rows containing legacy `intelligible` remain accepted and are normalized to `highly_intelligible`; all subsequent saves and exports emit only the canonical value. This compatibility is implemented in both TypeScript and Rust without changing project schema version 1.

Speech marked highly or partially intelligible requires transcription. Unintelligible speech may have blank transcription. Non-speech continues to normalize to `not_applicable`, a null speaker, blank transcription, and no overlap.

## Interaction and Accessibility

All controls receive consistent custom styling for default, hover, focus-visible, active, disabled, and invalid states. Checkboxes, range inputs, select/listbox controls, dialogs, chips, and scrollbars use semantic theme tokens. Focus rings meet contrast requirements, dialogs trap focus and close with Escape, and icon-only actions have accessible names and tooltips.

The selected-row, speaker, acoustic-tag, and intelligibility colors are reinforced through labels, borders, icons, or position. Motion is limited to short state transitions and respects `prefers-reduced-motion`.

## Verification Boundaries

Frontend tests cover palette validation/persistence, settings-dialog behavior, label-manager relocation, acoustic-tag multi-select keyboard behavior, fixed intelligibility values and legacy normalization, inspector Enter/Shift+Enter/IME behavior, saved-list scrolling and selection, stable color assignment, and toolbar layout contracts. Existing timeline, waveform, store-race, recovery, TSV, native integration, and end-to-end tests remain part of the final verification.

Per the requested workflow, tests are written before production changes but test commands are run only at the verification gate immediately before each commit.
