# Waveform Region and Inspector QoL Design

**Date:** 2026-07-22

## Summary

Lightscribe will make saved waveform annotation regions directly discoverable without changing the existing single-click selection workflow. Hovering a passive saved region will show the same transient waveform preview used by saved-list row hover, and double-clicking that region will activate its annotation exactly as clicking its saved-list row does. Single-clicking a passive region will not change the active selection, draft, playback, or persisted project.

The Selection inspector will stop duplicating annotation deletion. Its active-annotation action row will instead provide a way to begin a fresh annotation at the current loop boundaries. The existing Clear control will use a compact visible `X` while retaining an explicit accessible name.

This document supersedes the passive-region interactivity and Selection-inspector action requirements in [Transcription and Waveform QoL Design](2026-07-21-transcription-waveform-qol-design.md). That document remains authoritative for all other transcription editor, saved-list, waveform rendering, and preview-isolation behavior.

## Waveform region interaction

The existing WaveSurfer Regions adapter remains the only layer that knows about WaveSurfer region instances. It will expose annotation preview and activation callbacks alongside its existing canonical-selection callback. The adapter will use WaveSurfer Regions' supported per-region `over` and `leave` events and plugin-level `region-double-clicked` event; components outside the adapter will not attach listeners to WaveSurfer-owned DOM nodes.

Passive annotation regions remain fixed: `drag` and `resize` are both disabled. They become pointer-interactive and use a pointer cursor. The preview overlay stays pointer-transparent and above passive regions so it cannot interrupt leave or double-click delivery. The canonical loop selection retains its existing higher interaction layer and drag/resize behavior.

Interaction behavior is exact:

- Entering a passive annotation region requests preview of that annotation ID.
- Leaving it clears the preview only when that same annotation still owns the preview, preventing a stale leave from clearing a newer preview.
- Double-clicking it activates that annotation through the same `ProjectStore.selectAnnotation(id)` path used by a saved-list row.
- Single-clicking it has no application-state effect.
- Hover never changes the draft, active annotation, canonical selection, playback loop, recovery data, or persisted project.
- Activation is ignored while project transitions disable the workspace.
- If passive regions overlap, the topmost visible passive region receives pointer interaction. No region-lane or overlap-selection menu is introduced.

`App.svelte` remains the owner of the ephemeral preview annotation ID. Both list-row hover and waveform-region hover write to that same state. Waveform double-click activation delegates to `ProjectStore.selectAnnotation(id)`, so draft loading, loop synchronization, recovery scheduling, and row active styling remain identical regardless of activation source.

The adapter must clean up all passive-region hover subscriptions, double-click subscriptions, and callbacks when a region is removed, replaced, or the adapter is destroyed. Programmatic region synchronization must not emit user preview or activation intent.

## Selection inspector actions

The saved-annotation list remains the only place that exposes destructive removal. The Selection inspector no longer renders `Remove annotation`.

When no saved annotation is active, the inspector action row contains:

- `Add annotation`, which validates and commits the current draft.
- A compact visible `X`, with accessible name `Clear annotation`, which performs the existing full clear.

When a saved annotation is active, the inspector action row contains:

- `Update annotation`, which validates and commits changes to the active annotation.
- `Add annotation`, which begins a new unsaved draft at the current loop boundaries.
- The same `X` clear action.

Beginning a new draft from an active annotation is a local editor transition, not a commit. It must:

1. Preserve the current canonical loop boundaries in both `activeSelection` and the new draft's `startMs` and `endMs`.
2. Clear `activeAnnotationId` so the next successful submission creates a new annotation rather than updating the previous one.
3. Reset event type, transcription, intelligibility, overlap, confidence, acoustic tags, and notes to the existing project defaults.
4. Select the project's first speaker using the same default rule as the current clear behavior.
5. Leave every saved annotation unchanged until the user submits the new draft.
6. Schedule the existing recovery persistence for editor state, without invoking the committed-annotation save path.

If there is no active annotation, the secondary start-new action is absent because the primary action already adds the current draft. All inspector actions respect the existing disabled transition state.

The visible `X` continues to call the existing full-clear behavior: it detaches any active annotation, clears the canonical loop selection, and resets the draft. Its `aria-label` and tooltip identify it as `Clear annotation`; the glyph alone is not used as its accessible name.

## Components and interfaces

- `wavesurferAdapter.ts` owns passive-region event subscriptions and translates them into annotation IDs.
- `WaveformView.svelte` and `TimelineWorkspace.svelte` forward preview and activation callbacks without owning annotation state.
- `App.svelte` coordinates shared preview state and annotation activation.
- `ProjectStore` gains a narrowly named start-new transition that preserves the active selection while resetting the annotation draft.
- `AnnotationDashboard.svelte` renders the revised actions and retains its single validating submission coordinator.
- `AnnotationTable.svelte` keeps its current row hover, row activation, and delete behavior unchanged.

No domain schema, TSV shape, audio playback API, palette definition, keyboard shortcut, or label-management behavior changes.

## Error handling and lifecycle

An activation callback for an annotation ID that no longer exists is harmless because `ProjectStore.selectAnnotation` already ignores unknown IDs. Removing a currently previewed annotation continues to clear the preview through the existing annotation synchronization path.

Starting a new draft is ignored when mutations are blocked, no project is open, no annotation is active, or there is no valid active selection to preserve. These guards avoid constructing an invalid zero-length add draft from inconsistent recovery state.

## Verification contract

Testing follows consolidated TDD immediately before the implementation commit:

1. Write focused failing tests for passive-region hover, stale-leave protection, double-click activation, single-click isolation, cleanup, disabled-state suppression, the new start-new store transition, revised inspector actions, and the accessible `X`.
2. Run the focused tests once to demonstrate the expected RED failures.
3. Implement the smallest production change that satisfies them.
4. Run the focused tests GREEN, then the full frontend, Svelte, Rust, browser-flow, formatting, lint, and Tauri packaging gates.
5. Commit only after all required gates pass; do not rerun tests after that commit.

Browser coverage must prove waveform hover remains visual-only across the recovery debounce window and that waveform double-click activates the intended saved annotation. Component and adapter tests must verify cleanup and state isolation without relying solely on mocks of the behavior under test.
