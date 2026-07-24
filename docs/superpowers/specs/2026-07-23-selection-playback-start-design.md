# Selection Playback Start Design

## Goal

When playback is paused and the project has an active waveform selection, pressing Play or the Space shortcut starts playback from that selection's beginning. This makes a selected annotation or draft range immediately auditionable without requiring a separate seek.

## Behavior

- The active selection is `project.activeSelection`. Passive saved-region highlights and hover previews do not affect playback.
- Both the toolbar Play action and the global Space shortcut use one shared start-playback path.
- If an active selection exists, the application first seeks the native Rust playback engine to `selection.startMs` and waits for that seek to complete before issuing Play.
- If no active selection exists, Play preserves the existing behavior and begins from the native engine's current position.
- Pressing the control while already playing pauses without seeking or rewinding.
- Every paused-to-playing action with an active selection restarts from its beginning, including Play after a prior Pause.
- Loop enablement is independent. With Loop disabled, playback starts at the selection beginning and may continue beyond its end. With Loop enabled, the existing native loop behavior remains authoritative.
- A failed seek prevents Play from being issued and is reported through the existing persistent playback error path.

## Architecture and scope

The behavior belongs in `App.svelte`, which owns toolbar and keyboard playback commands and has access to both the active project selection and `AudioSession`. `AudioSession`, the native bridge, and the Rust engine retain their existing interfaces and timing authority.

The implementation will introduce one shared application-level playback toggle/start helper and route both input paths through it. It will not change waveform selection, loop ownership, persistence, TSV data, polling cadence, or native playback code.

## Testing

Application tests will prove that:

- Toolbar Play seeks to the active selection start before playing.
- Space performs the same ordered seek-then-play behavior.
- Repeated Play after Pause restarts from the active selection start.
- Play without an active selection does not seek.
- Pause never seeks.
- A seek failure prevents Play and reaches the existing error display.

Testing follows the project's consolidated TDD timing: observe focused RED before production changes, then run focused GREEN and the full verification gate immediately before committing. No tests run after the implementation commit.
