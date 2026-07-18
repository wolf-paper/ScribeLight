# Lightscribe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a packaged Tauri desktop application that provides a zoomable MP3/WAV waveform, sample-counted A/B looping, structured transcript annotations, local recovery, and portable TSV interchange.

**Architecture:** A Svelte/TypeScript frontend owns presentation, editor state, and user interaction. A Tauri Rust backend owns file access, atomic persistence, Symphonia decoding, waveform peak analysis, and a CPAL playback stream driven by a bounded real-time-safe ring buffer. WaveSurfer renders precomputed peaks and the active region but never controls playback timing.

**Tech Stack:** Tauri 2, Svelte 5, TypeScript, Bun, Vite, Vitest, Testing Library, WaveSurfer.js 7, Rust stable, CPAL 0.17, Symphonia 0.6, rtrb 0.3.4, serde, csv, atomic-write-file, Playwright.

## Global Constraints

- Support local MP3 and WAV recordings up to 30 minutes; reject other formats.
- Store canonical selection and annotation boundaries as integer milliseconds.
- Map milliseconds to the nearest source PCM frame and keep both loop edges within 1 ms in the emitted PCM stream.
- Do not decode or retain an entire 30-minute clip in frontend memory.
- Never allocate, decode, perform file I/O, log, or take an unbounded lock in the CPAL callback.
- Keep the timeline order: top ruler, draggable selection bar, highlighted waveform, bottom ruler.
- Implement `Ctrl+wheel` pointer-centered waveform zoom, Enter Add/Update, Shift+Enter newline, and IME-safe submission.
- New projects begin with `speaker_1`, `speaker_2`, `speaker_3`, and the approved Yamabiko acoustic-tag set; speakers and tags remain project-editable.
- Export UTF-8 TSV with the exact ten-column portable header from the design specification.
- Do not read adjacent JSON metadata, scan alternate worksheets, modify source audio, add ASR, or add translation features.
- Resolve current dependency versions during scaffolding, commit `bun.lock` and `src-tauri/Cargo.lock`, and do not use floating dependency versions after the first lock.
- Windows is the first verified packaged target; keep the audio and persistence interfaces platform-neutral for later macOS/Linux builds.

---

## File Map

### Frontend

- `src/main.ts` — mounts the Svelte application.
- `src/App.svelte` — top-level layout and application lifecycle.
- `src/app.css` — application-wide visual tokens and layout.
- `src/lib/domain/types.ts` — portable TypeScript project and annotation types.
- `src/lib/domain/time.ts` — millisecond formatting and PCM-frame conversion helpers.
- `src/lib/domain/selection.ts` — selection normalization and movement.
- `src/lib/domain/timeline.ts` — ruler ticks and pointer-centered zoom math.
- `src/lib/domain/importTsv.ts` — portable labels-to-stable-ID import merging.
- `src/lib/domain/project.ts` — project defaults and immutable speaker/tag mutations.
- `src/lib/domain/validation.ts` — structural annotation validation.
- `src/lib/state/projectStore.ts` — project, draft, annotation, and persistence orchestration.
- `src/lib/state/audioSession.ts` — native playback state and command orchestration.
- `src/lib/bridge/native.ts` — typed Tauri command/event boundary.
- `src/lib/waveform/wavesurferAdapter.ts` — isolated WaveSurfer lifecycle and region synchronization.
- `src/lib/components/ClipToolbar.svelte` — file, playback, volume, time-format, and export controls.
- `src/lib/components/TimelineWorkspace.svelte` — synchronized rulers, selection bar, waveform, and zoom viewport.
- `src/lib/components/TimeRuler.svelte` — time tick rendering.
- `src/lib/components/LoopSelectionBar.svelte` — active range handles and body dragging.
- `src/lib/components/WaveformView.svelte` — WaveSurfer host and playhead overlay.
- `src/lib/components/AnnotationDashboard.svelte` — active annotation editor and keyboard submission.
- `src/lib/components/SpeakerManager.svelte` — speaker add/rename/remove/reassign UI.
- `src/lib/components/AcousticTagManager.svelte` — acoustic-tag management UI.
- `src/lib/components/AnnotationTable.svelte` — ordered annotation list and row selection.
- `src/lib/components/ErrorBanner.svelte` — persistent actionable errors.

Tests live beside the frontend units as `*.test.ts` or `*.test.svelte.ts`.

### Rust backend

- `src-tauri/src/lib.rs` — Tauri builder, managed state, plugins, and commands.
- `src-tauri/src/model.rs` — serde-compatible project, annotation, audio, and peak types.
- `src-tauri/src/error.rs` — serializable application errors.
- `src-tauri/src/persistence.rs` — application-data paths and atomic JSON writes.
- `src-tauri/src/tsv.rs` — TSV import/export and multiline policies.
- `src-tauri/src/audio/mod.rs` — audio module exports.
- `src-tauri/src/audio/decoder.rs` — Symphonia probe, decode, and exact source-frame seek.
- `src-tauri/src/audio/peaks.rs` — bounded-memory waveform analysis and cache.
- `src-tauri/src/audio/loop_cursor.rs` — pure sample-counted A/B loop state machine.
- `src-tauri/src/audio/worker.rs` — decoder worker, frame conversion, and generation-tagged ring filling.
- `src-tauri/src/audio/engine.rs` — CPAL device selection, callback ownership, and playback facade.
- `src-tauri/src/commands.rs` — narrow Tauri command handlers.

Rust tests are colocated in `#[cfg(test)]` modules and `src-tauri/tests/`; the MP3 decoder fixture lives in `src-tauri/tests/fixtures/`, while cross-stack WAV/TSV fixtures live in `tests/fixtures/`.

---

### Task 1: Install Native Prerequisites and Scaffold a Tested Tauri/Svelte App

**Files:**
- Create: `package.json`, `bun.lock`, `index.html`, `vite.config.ts`, `svelte.config.js`, `tsconfig.json`
- Create: `src/main.ts`, `src/App.svelte`, `src/app.css`, `src/test/setup.ts`, `src/App.test.ts`
- Create: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Bun 1.3.14 already installed in the development environment.
- Produces: `bun test`, `bun run check`, `bun run build`, and `cargo test --manifest-path src-tauri/Cargo.toml` as green baseline commands.

- [ ] **Step 1: Install and verify the required Windows native toolchain**

Run in an approved elevated shell because Rust and Visual Studio Build Tools install outside the workspace:

```powershell
Invoke-WebRequest https://win.rustup.rs/x86_64 -OutFile C:\tmp\rustup-init.exe
C:\tmp\rustup-init.exe -y --default-toolchain stable-msvc --profile minimal
$rustBin = Join-Path $env:USERPROFILE '.cargo\bin'
$env:Path = "$rustBin;$env:Path"
rustup component add rustfmt clippy
rustup default stable-msvc
rustc --version
cargo --version
```

Install the two remaining official Tauri Windows prerequisites in the same approved elevated shell:

```powershell
Invoke-WebRequest https://aka.ms/vs/17/release/vs_BuildTools.exe -OutFile C:\tmp\vs_BuildTools.exe
Start-Process -FilePath C:\tmp\vs_BuildTools.exe -ArgumentList '--quiet','--wait','--norestart','--nocache','--add','Microsoft.VisualStudio.Workload.VCTools','--includeRecommended' -Wait
Invoke-WebRequest 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile C:\tmp\MicrosoftEdgeWebview2Setup.exe
Start-Process -FilePath C:\tmp\MicrosoftEdgeWebview2Setup.exe -ArgumentList '/silent','/install' -Wait
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
rustup show active-toolchain
```

Expected: `vswhere` prints an installation path and the active Rust toolchain ends in `stable-x86_64-pc-windows-msvc`. The WebView2 evergreen installer exits zero whether it installs or repairs the runtime.

- [ ] **Step 2: Generate the official Svelte/TypeScript/Tauri template without overwriting the existing docs**

```powershell
$scaffoldRoot = 'C:\tmp\lightscribe-tauri-scaffold'
if (Test-Path -LiteralPath $scaffoldRoot) {
  $resolved = (Resolve-Path -LiteralPath $scaffoldRoot).Path
  if ($resolved -ne 'C:\tmp\lightscribe-tauri-scaffold') { throw "Unexpected scaffold path: $resolved" }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
bunx create-tauri-app $scaffoldRoot --template svelte-ts --manager bun --identifier com.wolfpaper.lightscribe
Get-ChildItem -LiteralPath $scaffoldRoot -Force |
  Where-Object Name -NotIn @('.git') |
  Copy-Item -Destination . -Recurse -Force
```

Expected: the repository contains a Svelte frontend and `src-tauri`; `docs/` and the existing Git history remain intact.

- [ ] **Step 3: Add frontend dependencies and test scripts**

```powershell
bun add wavesurfer.js @tauri-apps/plugin-dialog
bun add --dev vitest @testing-library/svelte @testing-library/jest-dom jsdom
```

Set these scripts in `package.json`:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-check --tsconfig ./tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "tauri": "tauri"
  }
}
```

Configure `vite.config.ts`:

```ts
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts']
  }
});
```

Create `src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/svelte';
import { afterEach } from 'vitest';

afterEach(() => cleanup());
```

- [ ] **Step 4: Write the failing application-shell test**

Create `src/App.test.ts`:

```ts
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import App from './App.svelte';

describe('App', () => {
  it('identifies the product and its empty state', () => {
    render(App);
    expect(screen.getByRole('heading', { name: 'Lightscribe' })).toBeInTheDocument();
    expect(screen.getByText('Open an MP3 or WAV file to begin.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run the test and verify the generated welcome screen fails it**

Run: `bun test src/App.test.ts`  
Expected: FAIL because the generated app does not contain the Lightscribe heading and empty-state copy.

- [ ] **Step 6: Replace the generated demo with the minimal application shell**

Create `src/App.svelte`:

```svelte
<script lang="ts">
  let hasAudio = false;
</script>

<svelte:head><title>Lightscribe</title></svelte:head>

<main class="app-shell">
  <header><h1>Lightscribe</h1></header>
  {#if !hasAudio}
    <section class="empty-state" aria-live="polite">
      <p>Open an MP3 or WAV file to begin.</p>
    </section>
  {/if}
</main>
```

Create `src/app.css` with the initial design tokens:

```css
:root {
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  color: #e8edf5;
  background: #11151c;
  font-synthesis: none;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 720px; min-height: 100vh; }
button, input, select, textarea { font: inherit; }
.app-shell { min-height: 100vh; padding: 1.25rem; }
.empty-state { display: grid; min-height: 60vh; place-items: center; color: #9da9b8; }
```

Ensure `src/main.ts` imports `./app.css` and mounts `App`.

- [ ] **Step 7: Run every baseline verification command**

```powershell
bun test
bun run check
bun run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all commands exit zero; Vitest reports the App test passing and Cargo reports the generated Rust tests passing.

- [ ] **Step 8: Commit the scaffold**

```powershell
git add .gitignore package.json bun.lock index.html vite.config.ts svelte.config.js tsconfig.json src src-tauri
git commit -m "chore: scaffold Lightscribe desktop app"
```

---

### Task 2: Define Portable Domain Types, Time Formatting, and Selection Math

**Files:**
- Create: `src/lib/domain/types.ts`
- Create: `src/lib/domain/time.ts`
- Create: `src/lib/domain/time.test.ts`
- Create: `src/lib/domain/selection.ts`
- Create: `src/lib/domain/selection.test.ts`
- Create: `src/lib/domain/project.ts`
- Create: `src/lib/domain/project.test.ts`

**Interfaces:**
- Consumes: browser `crypto.randomUUID()`.
- Produces: `Project`, `Annotation`, `AnnotationDraft`, `Selection`, `formatTime()`, `millisecondsToFrame()`, `normalizeSelection()`, `moveSelection()`, and `createProject()`.

- [ ] **Step 1: Write failing time and selection tests**

Create `src/lib/domain/time.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatTime, millisecondsToFrame } from './time';

describe('time', () => {
  it('formats both ruler modes', () => {
    expect(formatTime(72_345, 'seconds')).toBe('72.345');
    expect(formatTime(72_345, 'clock')).toBe('01:12.345');
  });

  it('maps milliseconds to the nearest PCM frame', () => {
    expect(millisecondsToFrame(1, 48_000)).toBe(48);
    expect(millisecondsToFrame(1, 44_100)).toBe(44);
  });
});
```

Create `src/lib/domain/selection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { moveSelection, normalizeSelection } from './selection';

describe('selection', () => {
  it('rounds and clamps a valid range', () => {
    expect(normalizeSelection(10.4, 101.6, 100)).toEqual({ startMs: 10, endMs: 100 });
  });

  it('rejects an empty range', () => {
    expect(normalizeSelection(10, 10, 100)).toBeNull();
  });

  it('moves without changing duration or leaving the clip', () => {
    expect(moveSelection({ startMs: 80, endMs: 100 }, 30, 110)).toEqual({ startMs: 90, endMs: 110 });
  });
});
```

- [ ] **Step 2: Run the tests and verify missing modules fail**

Run: `bun test src/lib/domain/time.test.ts src/lib/domain/selection.test.ts`  
Expected: FAIL with module-resolution errors for `./time` and `./selection`.

- [ ] **Step 3: Implement the time and selection functions**

Create `src/lib/domain/time.ts`:

```ts
import type { TimeDisplayFormat } from './types';

export function formatTime(milliseconds: number, format: TimeDisplayFormat): string {
  const safe = Math.max(0, Math.round(milliseconds));
  if (format === 'seconds') return (safe / 1000).toFixed(3);
  const minutes = Math.floor(safe / 60_000);
  const seconds = (safe % 60_000) / 1000;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toFixed(3).padStart(6, '0')}`;
}

export function millisecondsToFrame(milliseconds: number, sampleRate: number): number {
  if (!Number.isFinite(milliseconds) || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('milliseconds and sampleRate must be finite; sampleRate must be positive');
  }
  return Math.round((milliseconds * sampleRate) / 1000);
}
```

Create `src/lib/domain/selection.ts`:

```ts
import type { Selection } from './types';

export function normalizeSelection(startMs: number, endMs: number, durationMs: number): Selection | null {
  const start = Math.min(durationMs, Math.max(0, Math.round(startMs)));
  const end = Math.min(durationMs, Math.max(0, Math.round(endMs)));
  if (end <= start) return null;
  return { startMs: start, endMs: end };
}

export function moveSelection(selection: Selection, deltaMs: number, durationMs: number): Selection {
  const width = selection.endMs - selection.startMs;
  const startMs = Math.min(Math.max(0, selection.startMs + Math.round(deltaMs)), durationMs - width);
  return { startMs, endMs: startMs + width };
}
```

- [ ] **Step 4: Define the portable domain types and defaults**

Create `src/lib/domain/types.ts`:

```ts
export type TimeDisplayFormat = 'seconds' | 'clock';
export type EventType = 'speech' | 'non_speech';
export type Intelligibility = 'intelligible' | 'partially_intelligible' | 'unintelligible' | 'not_applicable';
export type Overlap = 'none' | 'overlap';
export type Confidence = 'high' | 'medium' | 'low';
export type MultilinePolicy = 'escape' | 'space' | 'quoted';

export interface Selection { startMs: number; endMs: number }
export interface LabelDefinition { id: string; label: string }
export interface AudioIdentity {
  canonicalPath: string;
  size: number;
  modifiedMs: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
}
export interface Annotation {
  id: string;
  startMs: number;
  endMs: number;
  eventType: EventType;
  transcription: string;
  intelligibility: Intelligibility;
  speakerId: string | null;
  overlap: Overlap;
  confidence: Confidence;
  acousticTagIds: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}
export type AnnotationDraft = Omit<Annotation, 'id' | 'createdAt' | 'updatedAt'>;
export interface ExportSettings { multilinePolicy: MultilinePolicy }
export interface Project {
  schemaVersion: 1;
  audioIdentity: AudioIdentity;
  displayFormat: TimeDisplayFormat;
  speakers: LabelDefinition[];
  acousticTags: LabelDefinition[];
  annotations: Annotation[];
  draft: AnnotationDraft;
  activeAnnotationId: string | null;
  activeSelection: Selection | null;
  exportSettings: ExportSettings;
}
```

Create `src/lib/domain/project.ts`:

```ts
import type { AnnotationDraft, AudioIdentity, LabelDefinition, Project } from './types';

export const DEFAULT_TAG_LABELS = [
  'quiet_dialogue', 'loud_dialogue', 'high_f0_nonmodal', 'overlap', 'music',
  'effects_noise', 'music_effects_noise', 'rapid_turns', 'short_acknowledgements',
  'long_endpoint', 'non_speech_control', 'background_speech', 'singing', 'laugh',
  'breath', 'incomplete_word'
] as const;

const label = (value: string): LabelDefinition => ({ id: crypto.randomUUID(), label: value });

export function emptyDraft(): AnnotationDraft {
  return {
    startMs: 0, endMs: 0, eventType: 'speech', transcription: '',
    intelligibility: 'intelligible', speakerId: null, overlap: 'none',
    confidence: 'high', acousticTagIds: [], notes: ''
  };
}

export function createProject(audioIdentity: AudioIdentity): Project {
  const speakers = ['speaker_1', 'speaker_2', 'speaker_3'].map(label);
  return {
    schemaVersion: 1,
    audioIdentity,
    displayFormat: 'seconds',
    speakers,
    acousticTags: DEFAULT_TAG_LABELS.map(label),
    annotations: [],
    draft: { ...emptyDraft(), speakerId: speakers[0].id },
    activeAnnotationId: null,
    activeSelection: null,
    exportSettings: { multilinePolicy: 'escape' }
  };
}
```

- [ ] **Step 5: Add and run the project-default test**

Create `src/lib/domain/project.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createProject, DEFAULT_TAG_LABELS } from './project';

describe('createProject', () => {
  it('seeds editable speakers and tags', () => {
    const project = createProject({
      canonicalPath: 'clip.wav', size: 10, modifiedMs: 1, durationMs: 240_000,
      sampleRate: 48_000, channels: 1
    });
    expect(project.speakers.map((item) => item.label)).toEqual(['speaker_1', 'speaker_2', 'speaker_3']);
    expect(project.acousticTags.map((item) => item.label)).toEqual([...DEFAULT_TAG_LABELS]);
    expect(project.draft.speakerId).toBe(project.speakers[0].id);
  });
});
```

Run: `bun test src/lib/domain`  
Expected: all domain tests pass.

- [ ] **Step 6: Run checks and commit**

```powershell
bun run check
bun test
git add src/lib/domain
git commit -m "feat: add annotation domain model"
```

---

### Task 3: Implement Project Mutations and Annotation Validation

**Files:**
- Modify: `src/lib/domain/project.ts`
- Create: `src/lib/domain/projectMutations.test.ts`
- Create: `src/lib/domain/validation.ts`
- Create: `src/lib/domain/validation.test.ts`

**Interfaces:**
- Consumes: `Project`, `AnnotationDraft`, and stable label IDs from Task 2.
- Produces: immutable `addLabel()`, `renameSpeaker()`, `removeSpeaker()`, `renameTag()`, `removeTag()`, `normalizeDraftForEventType()`, and `validateDraft()`.

- [ ] **Step 1: Write failing mutation tests**

Create `src/lib/domain/projectMutations.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createProject, removeSpeaker, removeTag, renameSpeaker, renameTag } from './project';

const audio = { canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 };

describe('project label mutations', () => {
  it('renames labels through stable IDs', () => {
    let project = createProject(audio);
    project = renameSpeaker(project, project.speakers[0].id, 'narrator');
    project = renameTag(project, project.acousticTags[0].id, 'whisper');
    expect(project.speakers[0].label).toBe('narrator');
    expect(project.acousticTags[0].label).toBe('whisper');
  });

  it('requires speaker reassignment when referenced', () => {
    const project = createProject(audio);
    const used = project.speakers[0].id;
    const reassigned = project.speakers[1].id;
    project.annotations.push({ ...project.draft, id: 'a', speakerId: used, startMs: 1, endMs: 2, createdAt: 'x', updatedAt: 'x' });
    expect(() => removeSpeaker(project, used)).toThrow('reassignment');
    expect(removeSpeaker(project, used, reassigned).annotations[0].speakerId).toBe(reassigned);
  });

  it('removes a confirmed referenced tag from annotations', () => {
    const project = createProject(audio);
    const tagId = project.acousticTags[0].id;
    project.annotations.push({ ...project.draft, id: 'a', acousticTagIds: [tagId], startMs: 1, endMs: 2, createdAt: 'x', updatedAt: 'x' });
    expect(() => removeTag(project, tagId, false)).toThrow('confirmation');
    expect(removeTag(project, tagId, true).annotations[0].acousticTagIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the mutation tests and verify missing exports fail**

Run: `bun test src/lib/domain/projectMutations.test.ts`  
Expected: FAIL because the mutation functions are not exported.

- [ ] **Step 3: Implement immutable speaker and tag mutations**

Append to `src/lib/domain/project.ts`:

```ts
function requireUniqueLabel(items: LabelDefinition[], nextLabel: string, exceptId?: string): string {
  const normalized = nextLabel.trim();
  if (!normalized) throw new Error('Label cannot be empty');
  if (normalized === 'none') throw new Error('The label none is reserved');
  if (items.some((item) => item.id !== exceptId && item.label === normalized)) throw new Error('Label must be unique');
  return normalized;
}

export function addLabel(project: Project, kind: 'speakers' | 'acousticTags', nextLabel: string): Project {
  const value = requireUniqueLabel(project[kind], nextLabel);
  return { ...project, [kind]: [...project[kind], label(value)] };
}

export function renameSpeaker(project: Project, id: string, nextLabel: string): Project {
  const value = requireUniqueLabel(project.speakers, nextLabel, id);
  return { ...project, speakers: project.speakers.map((item) => item.id === id ? { ...item, label: value } : item) };
}

export function renameTag(project: Project, id: string, nextLabel: string): Project {
  const value = requireUniqueLabel(project.acousticTags, nextLabel, id);
  return { ...project, acousticTags: project.acousticTags.map((item) => item.id === id ? { ...item, label: value } : item) };
}

export function removeSpeaker(project: Project, id: string, reassignTo?: string): Project {
  const referenced = project.annotations.some((annotation) => annotation.speakerId === id);
  if (referenced && !reassignTo) throw new Error('Speaker reassignment is required');
  if (reassignTo && !project.speakers.some((speaker) => speaker.id === reassignTo && speaker.id !== id)) {
    throw new Error('Reassignment target does not exist');
  }
  return {
    ...project,
    speakers: project.speakers.filter((speaker) => speaker.id !== id),
    annotations: project.annotations.map((annotation) => annotation.speakerId === id ? { ...annotation, speakerId: reassignTo ?? null } : annotation),
    draft: project.draft.speakerId === id ? { ...project.draft, speakerId: reassignTo ?? null } : project.draft
  };
}

export function removeTag(project: Project, id: string, confirmed: boolean): Project {
  const referenced = project.annotations.some((annotation) => annotation.acousticTagIds.includes(id));
  if (referenced && !confirmed) throw new Error('Tag removal requires confirmation');
  return {
    ...project,
    acousticTags: project.acousticTags.filter((tag) => tag.id !== id),
    annotations: project.annotations.map((annotation) => ({ ...annotation, acousticTagIds: annotation.acousticTagIds.filter((tagId) => tagId !== id) })),
    draft: { ...project.draft, acousticTagIds: project.draft.acousticTagIds.filter((tagId) => tagId !== id) }
  };
}
```

- [ ] **Step 4: Write failing conditional-validation tests**

Create `src/lib/domain/validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createProject } from './project';
import { normalizeDraftForEventType, validateDraft } from './validation';

const audio = { canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 };

describe('annotation validation', () => {
  it('requires an ordered in-bounds selection and transcription for intelligible speech', () => {
    const project = createProject(audio);
    const errors = validateDraft({ ...project.draft, startMs: 500, endMs: 500, transcription: '' }, project);
    expect(errors.endMs).toContain('later');
    expect(errors.transcription).toContain('required');
  });

  it('normalizes non-speech fields', () => {
    const project = createProject(audio);
    const result = normalizeDraftForEventType({ ...project.draft, transcription: 'words' }, 'non_speech');
    expect(result).toMatchObject({ eventType: 'non_speech', transcription: '', intelligibility: 'not_applicable', speakerId: null });
  });
});
```

- [ ] **Step 5: Implement validation and non-speech normalization**

Create `src/lib/domain/validation.ts`:

```ts
import type { AnnotationDraft, EventType, Project } from './types';

export type FieldErrors = Partial<Record<keyof AnnotationDraft, string>>;

export function normalizeDraftForEventType(draft: AnnotationDraft, eventType: EventType): AnnotationDraft {
  if (eventType === 'speech') return { ...draft, eventType, intelligibility: draft.intelligibility === 'not_applicable' ? 'intelligible' : draft.intelligibility };
  return { ...draft, eventType, transcription: '', intelligibility: 'not_applicable', speakerId: null, overlap: 'none' };
}

export function validateDraft(draft: AnnotationDraft, project: Project): FieldErrors {
  const errors: FieldErrors = {};
  if (!Number.isInteger(draft.startMs) || draft.startMs < 0) errors.startMs = 'Start must be a non-negative integer millisecond value';
  if (!Number.isInteger(draft.endMs) || draft.endMs <= draft.startMs) errors.endMs = 'End must be later than start';
  else if (draft.endMs > project.audioIdentity.durationMs) errors.endMs = 'End must not exceed the clip duration';
  if (draft.transcription.includes('\t')) errors.transcription = 'Transcription cannot contain tabs';
  if (draft.notes.includes('\t')) errors.notes = 'Notes cannot contain tabs';
  if (draft.eventType === 'speech') {
    if (!draft.speakerId || !project.speakers.some((speaker) => speaker.id === draft.speakerId)) errors.speakerId = 'A project speaker is required';
    if ((draft.intelligibility === 'intelligible' || draft.intelligibility === 'partially_intelligible') && !draft.transcription.trim()) {
      errors.transcription = 'Transcription is required for intelligible speech';
    }
  }
  if (draft.acousticTagIds.some((id) => !project.acousticTags.some((tag) => tag.id === id))) errors.acousticTagIds = 'Every tag must exist in the project';
  return errors;
}
```

- [ ] **Step 6: Run tests, checks, and commit**

```powershell
bun test src/lib/domain
bun run check
git add src/lib/domain
git commit -m "feat: validate annotations and editable labels"
```

---

### Task 4: Mirror the Domain in Rust and Add Atomic Project Persistence

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/model.rs`
- Create: `src-tauri/src/error.rs`
- Create: `src-tauri/src/persistence.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: the camelCase JSON representation from `src/lib/domain/types.ts`.
- Produces: `Project`, `Annotation`, `AudioIdentity`, `AppError`, `project_path()`, `save_project_to()`, and `load_project_from()` for later Tauri commands.

- [ ] **Step 1: Add serialization and atomic-write dependencies**

```powershell
Set-Location src-tauri
cargo add serde --features derive
cargo add serde_json thiserror atomic-write-file blake3
Set-Location ..
```

- [ ] **Step 2: Write a failing JSON compatibility and atomic overwrite test**

Create `src-tauri/src/persistence.rs` with only the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn project() -> Project {
        Project::fixture("C:/clips/a.wav")
    }

    #[test]
    fn saves_and_replaces_a_project_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("project.json");
        let mut value = project();
        save_project_to(&path, &value).unwrap();
        value.display_format = TimeDisplayFormat::Clock;
        save_project_to(&path, &value).unwrap();
        assert_eq!(load_project_from(&path).unwrap().display_format, TimeDisplayFormat::Clock);
    }
}
```

Add `tempfile` as a development dependency:

```powershell
Set-Location src-tauri
cargo add --dev tempfile
Set-Location ..
```

- [ ] **Step 3: Run the test and verify missing model/functions fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml persistence::tests`  
Expected: FAIL because `crate::model`, `save_project_to`, and `load_project_from` do not exist.

- [ ] **Step 4: Implement Rust types with the same wire names as TypeScript**

Create `src-tauri/src/model.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioIdentity { pub canonical_path: String, pub size: u64, pub modified_ms: i64, pub duration_ms: u64, pub sample_rate: u32, pub channels: u16 }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Selection { #[serde(rename = "startMs")] pub start_ms: u64, #[serde(rename = "endMs")] pub end_ms: u64 }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LabelDefinition { pub id: String, pub label: String }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum EventType { Speech, NonSpeech }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Intelligibility { Intelligible, PartiallyIntelligible, Unintelligible, NotApplicable }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Overlap { None, Overlap }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Confidence { High, Medium, Low }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TimeDisplayFormat { Seconds, Clock }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MultilinePolicy { Escape, Space, Quoted }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String, pub start_ms: u64, pub end_ms: u64, pub event_type: EventType,
    pub transcription: String, pub intelligibility: Intelligibility, pub speaker_id: Option<String>,
    pub overlap: Overlap, pub confidence: Confidence, pub acoustic_tag_ids: Vec<String>,
    pub notes: String, pub created_at: String, pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationDraft {
    pub start_ms: u64, pub end_ms: u64, pub event_type: EventType, pub transcription: String,
    pub intelligibility: Intelligibility, pub speaker_id: Option<String>, pub overlap: Overlap,
    pub confidence: Confidence, pub acoustic_tag_ids: Vec<String>, pub notes: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings { pub multiline_policy: MultilinePolicy }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32, pub audio_identity: AudioIdentity, pub display_format: TimeDisplayFormat,
    pub speakers: Vec<LabelDefinition>, pub acoustic_tags: Vec<LabelDefinition>,
    pub annotations: Vec<Annotation>, pub draft: AnnotationDraft,
    pub active_annotation_id: Option<String>, pub active_selection: Option<Selection>,
    pub export_settings: ExportSettings,
}

#[cfg(test)]
impl Project {
    pub fn fixture(path: &str) -> Self {
        Self {
            schema_version: 1,
            audio_identity: AudioIdentity { canonical_path: path.into(), size: 1, modified_ms: 1, duration_ms: 1000, sample_rate: 48000, channels: 1 },
            display_format: TimeDisplayFormat::Seconds,
            speakers: vec![LabelDefinition { id: "s1".into(), label: "speaker_1".into() }],
            acoustic_tags: vec![], annotations: vec![],
            draft: AnnotationDraft { start_ms: 0, end_ms: 0, event_type: EventType::Speech, transcription: String::new(), intelligibility: Intelligibility::Intelligible, speaker_id: Some("s1".into()), overlap: Overlap::None, confidence: Confidence::High, acoustic_tag_ids: vec![], notes: String::new() },
            active_annotation_id: None, active_selection: None,
            export_settings: ExportSettings { multiline_policy: MultilinePolicy::Escape },
        }
    }
}
```

- [ ] **Step 5: Implement serializable errors and atomic project I/O**

Create `src-tauri/src/error.rs`:

```rust
use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum AppError {
    #[error("File operation failed: {0}")] Io(String),
    #[error("Project data is invalid: {0}")] InvalidProject(String),
    #[error("Audio operation failed: {0}")] Audio(String),
    #[error("TSV operation failed: {0}")] Tsv(String),
}
impl From<std::io::Error> for AppError { fn from(value: std::io::Error) -> Self { Self::Io(value.to_string()) } }
```

Complete `src-tauri/src/persistence.rs`:

```rust
use crate::{error::AppError, model::Project};
use atomic_write_file::AtomicWriteFile;
use std::{io::Write, path::{Path, PathBuf}};

pub fn project_path(app_data_dir: &Path, canonical_audio_path: &str) -> PathBuf {
    let hash = blake3::hash(canonical_audio_path.as_bytes()).to_hex();
    app_data_dir.join("projects").join(format!("{hash}.json"))
}

pub fn save_project_to(path: &Path, project: &Project) -> Result<(), AppError> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    let bytes = serde_json::to_vec_pretty(project).map_err(|error| AppError::InvalidProject(error.to_string()))?;
    let mut file = AtomicWriteFile::options().open(path)?;
    file.write_all(&bytes)?;
    file.commit()?;
    Ok(())
}

pub fn load_project_from(path: &Path) -> Result<Project, AppError> {
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(|error| AppError::InvalidProject(error.to_string()))
}
```

Declare `mod error; mod model; mod persistence;` in `src-tauri/src/lib.rs`.

- [ ] **Step 6: Run Rust tests and commit**

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
git add src-tauri
git commit -m "feat: persist versioned projects atomically"
```

---

### Task 5: Implement Portable TSV Import and Export in Rust

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/tsv.rs`
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `Project` and `MultilinePolicy` from Task 4.
- Produces: `ImportedTsv`, `parse_tsv()`, `export_tsv()`, `read_tsv`, `write_tsv`, `load_project`, and `save_project` Tauri commands.

- [ ] **Step 1: Add TSV and Tauri dialog dependencies**

```powershell
Set-Location src-tauri
cargo add csv
cargo add tauri-plugin-dialog
Set-Location ..
```

- [ ] **Step 2: Write failing tests for the portable header, Japanese alias, labels, and multiline policies**

Create `src-tauri/src/tsv.rs` with this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    #[test]
    fn exports_the_portable_header_and_three_decimal_times() {
        let mut project = Project::fixture("a.wav");
        project.annotations.push(Annotation {
            id: "a1".into(), start_ms: 842, end_ms: 2115, event_type: EventType::Speech,
            transcription: "ちょっと待って".into(), intelligibility: Intelligibility::Intelligible,
            speaker_id: Some("s1".into()), overlap: Overlap::None, confidence: Confidence::High,
            acoustic_tag_ids: vec![], notes: String::new(), created_at: "1".into(), updated_at: "1".into(),
        });
        let text = export_tsv(&project).unwrap();
        assert!(text.starts_with("start_seconds\tend_seconds\tevent_type\ttranscription\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\tnotes\n"));
        assert!(text.contains("0.842\t2.115\tspeech\tちょっと待って"));
    }

    #[test]
    fn imports_japanese_as_transcription_and_discovers_labels() {
        let text = "start_seconds\tend_seconds\tevent_type\tjapanese\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\tnotes\n0.100\t0.250\tspeech\tうん\tintelligible\tspeaker_7\tnone\thigh\tquiet_dialogue;breath\t\n";
        let imported = parse_tsv(text, MultilinePolicy::Escape).unwrap();
        assert_eq!(imported.annotations[0].transcription, "うん");
        assert_eq!(imported.speakers, vec!["speaker_7"]);
        assert_eq!(imported.acoustic_tags, vec!["quiet_dialogue", "breath"]);
    }

    #[test]
    fn escape_policy_round_trips_backslashes_and_newlines() {
        let source = "first\\path\nsecond";
        let encoded = encode_multiline(source, MultilinePolicy::Escape);
        assert_eq!(decode_multiline(&encoded, MultilinePolicy::Escape), source);
    }
}
```

- [ ] **Step 3: Run the tests and verify missing functions fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tsv::tests`  
Expected: FAIL because the TSV functions and import types do not exist.

- [ ] **Step 4: Implement deterministic multiline encoding and TSV wire rows**

Add to `src-tauri/src/tsv.rs`:

```rust
use crate::{error::AppError, model::*};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const HEADER: [&str; 10] = [
    "start_seconds", "end_seconds", "event_type", "transcription", "intelligibility",
    "speaker", "overlap", "confidence", "acoustic_tags", "notes",
];

#[derive(Debug, Serialize, Deserialize)]
struct TsvRow {
    start_seconds: String,
    end_seconds: String,
    event_type: String,
    #[serde(alias = "japanese")]
    transcription: String,
    intelligibility: String,
    speaker: String,
    overlap: String,
    confidence: String,
    acoustic_tags: String,
    notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAnnotation {
    pub start_ms: u64, pub end_ms: u64, pub event_type: EventType, pub transcription: String,
    pub intelligibility: Intelligibility, pub speaker: Option<String>, pub overlap: Overlap,
    pub confidence: Confidence, pub acoustic_tags: Vec<String>, pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImportedTsv {
    pub annotations: Vec<ImportedAnnotation>,
    pub speakers: Vec<String>,
    #[serde(rename = "acousticTags")]
    pub acoustic_tags: Vec<String>,
}

pub fn encode_multiline(value: &str, policy: MultilinePolicy) -> String {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    match policy {
        MultilinePolicy::Escape => normalized.replace('\\', "\\\\").replace('\n', "\\n"),
        MultilinePolicy::Space => normalized.replace('\n', " "),
        MultilinePolicy::Quoted => normalized,
    }
}

pub fn decode_multiline(value: &str, policy: MultilinePolicy) -> String {
    if policy != MultilinePolicy::Escape { return value.to_owned(); }
    let mut decoded = String::new();
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character != '\\' { decoded.push(character); continue; }
        match chars.next() {
            Some('n') => decoded.push('\n'),
            Some('\\') => decoded.push('\\'),
            Some(other) => { decoded.push('\\'); decoded.push(other); }
            None => decoded.push('\\'),
        }
    }
    decoded
}
```

- [ ] **Step 5: Implement import/export conversion**

Complete `src-tauri/src/tsv.rs` with:

```rust
fn enum_text<T: Serialize>(value: &T) -> Result<String, AppError> {
    serde_json::to_value(value).map_err(|error| AppError::Tsv(error.to_string()))?
        .as_str().map(str::to_owned).ok_or_else(|| AppError::Tsv("Expected string enum".into()))
}

fn parse_enum<T: for<'de> Deserialize<'de>>(value: &str, field: &str) -> Result<T, AppError> {
    serde_json::from_value(serde_json::Value::String(value.to_owned()))
        .map_err(|_| AppError::Tsv(format!("Unsupported {field} value: {value}")))
}

fn seconds_to_ms(value: &str, field: &str) -> Result<u64, AppError> {
    let seconds: f64 = value.parse().map_err(|_| AppError::Tsv(format!("Invalid {field}: {value}")))?;
    if !seconds.is_finite() || seconds < 0.0 { return Err(AppError::Tsv(format!("Invalid {field}: {value}"))); }
    Ok((seconds * 1000.0).round() as u64)
}

pub fn export_tsv(project: &Project) -> Result<String, AppError> {
    let speaker = |id: &Option<String>| id.as_ref()
        .and_then(|id| project.speakers.iter().find(|item| &item.id == id))
        .map(|item| item.label.clone()).unwrap_or_else(|| "none".into());
    let tags = |ids: &[String]| ids.iter().filter_map(|id| project.acoustic_tags.iter().find(|item| &item.id == id)).map(|item| item.label.as_str()).collect::<Vec<_>>().join(";");
    let mut annotations = project.annotations.clone();
    annotations.sort_by_key(|item| (item.start_ms, item.end_ms, item.created_at.clone()));
    let mut writer = csv::WriterBuilder::new().has_headers(false).delimiter(b'\t').lineterminator(csv::Terminator::Any(b'\n')).from_writer(vec![]);
    writer.write_record(HEADER).map_err(|error| AppError::Tsv(error.to_string()))?;
    for annotation in annotations {
        if annotation.end_ms <= annotation.start_ms || annotation.end_ms > project.audio_identity.duration_ms {
            return Err(AppError::Tsv(format!("Annotation {} has invalid boundaries", annotation.id)));
        }
        if annotation.transcription.contains('\t') || annotation.notes.contains('\t') {
            return Err(AppError::Tsv(format!("Annotation {} contains a tab in a text field", annotation.id)));
        }
        writer.serialize(TsvRow {
            start_seconds: format!("{:.3}", annotation.start_ms as f64 / 1000.0),
            end_seconds: format!("{:.3}", annotation.end_ms as f64 / 1000.0),
            event_type: enum_text(&annotation.event_type)?,
            transcription: encode_multiline(&annotation.transcription, project.export_settings.multiline_policy.clone()),
            intelligibility: enum_text(&annotation.intelligibility)?,
            speaker: speaker(&annotation.speaker_id), overlap: enum_text(&annotation.overlap)?,
            confidence: enum_text(&annotation.confidence)?, acoustic_tags: tags(&annotation.acoustic_tag_ids),
            notes: encode_multiline(&annotation.notes, project.export_settings.multiline_policy.clone()),
        }).map_err(|error| AppError::Tsv(error.to_string()))?;
    }
    let bytes = writer.into_inner().map_err(|error| AppError::Tsv(error.to_string()))?;
    String::from_utf8(bytes).map_err(|error| AppError::Tsv(error.to_string()))
}

pub fn parse_tsv(text: &str, multiline_policy: MultilinePolicy) -> Result<ImportedTsv, AppError> {
    let mut reader = csv::ReaderBuilder::new().delimiter(b'\t').flexible(false).from_reader(text.as_bytes());
    let headers = reader.headers().map_err(|error| AppError::Tsv(error.to_string()))?.clone();
    let names: Vec<&str> = headers.iter().collect();
    let valid = names == HEADER || names == HEADER.map(|name| if name == "transcription" { "japanese" } else { name });
    if !valid { return Err(AppError::Tsv("Expected the ten portable columns, with transcription or japanese in column four".into())); }
    let mut annotations = vec![];
    let mut speakers = BTreeSet::new();
    let mut tags = BTreeSet::new();
    for row in reader.deserialize::<TsvRow>() {
        let row = row.map_err(|error| AppError::Tsv(error.to_string()))?;
        let start_ms = seconds_to_ms(&row.start_seconds, "start_seconds")?;
        let end_ms = seconds_to_ms(&row.end_seconds, "end_seconds")?;
        if end_ms <= start_ms { return Err(AppError::Tsv("end_seconds must be later than start_seconds".into())); }
        if row.transcription.contains('\t') || row.notes.contains('\t') { return Err(AppError::Tsv("Text fields cannot contain tabs".into())); }
        let event_type: EventType = parse_enum(&row.event_type, "event_type")?;
        let speaker = if row.speaker == "none" { None } else { speakers.insert(row.speaker.clone()); Some(row.speaker) };
        let acoustic_tags = row.acoustic_tags.split(';').filter(|tag| !tag.is_empty()).map(str::to_owned).collect::<Vec<_>>();
        tags.extend(acoustic_tags.iter().cloned());
        annotations.push(ImportedAnnotation {
            start_ms, end_ms,
            event_type, transcription: decode_multiline(&row.transcription, multiline_policy.clone()),
            intelligibility: parse_enum(&row.intelligibility, "intelligibility")?, speaker,
            overlap: parse_enum(&row.overlap, "overlap")?, confidence: parse_enum(&row.confidence, "confidence")?,
            acoustic_tags, notes: decode_multiline(&row.notes, multiline_policy.clone()),
        });
    }
    Ok(ImportedTsv { annotations, speakers: speakers.into_iter().collect(), acoustic_tags: tags.into_iter().collect() })
}
```

- [ ] **Step 6: Add narrow Tauri file commands**

Create `src-tauri/src/commands.rs`:

```rust
use crate::{error::AppError, model::{MultilinePolicy, Project}, persistence, tsv::{self, ImportedTsv}};
use atomic_write_file::AtomicWriteFile;
use std::{io::Write, path::PathBuf};
use tauri::{AppHandle, Manager};

fn app_data(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path().app_data_dir().map_err(|error| AppError::Io(error.to_string()))
}

#[tauri::command]
pub fn save_project(app: AppHandle, project: Project) -> Result<(), AppError> {
    let path = persistence::project_path(&app_data(&app)?, &project.audio_identity.canonical_path);
    persistence::save_project_to(&path, &project)
}

#[tauri::command]
pub fn load_project(app: AppHandle, canonical_audio_path: String) -> Result<Option<Project>, AppError> {
    let path = persistence::project_path(&app_data(&app)?, &canonical_audio_path);
    if !path.exists() { return Ok(None); }
    persistence::load_project_from(&path).map(Some)
}

#[tauri::command]
pub fn read_tsv(path: String, multiline_policy: MultilinePolicy) -> Result<ImportedTsv, AppError> {
    let text = std::fs::read_to_string(path)?;
    tsv::parse_tsv(&text, multiline_policy)
}

#[tauri::command]
pub fn write_tsv(path: String, project: Project) -> Result<(), AppError> {
    let text = tsv::export_tsv(&project)?;
    let mut file = AtomicWriteFile::options().open(path)?;
    file.write_all(text.as_bytes())?;
    file.commit()?;
    Ok(())
}
```

Register the dialog plugin, modules, and four commands in `src-tauri/src/lib.rs`:

```rust
mod commands;
mod error;
mod model;
mod persistence;
mod tsv;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::save_project, commands::load_project, commands::read_tsv, commands::write_tsv
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lightscribe");
}
```

- [ ] **Step 7: Run Rust verification and commit**

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
git add src-tauri
git commit -m "feat: import and export portable annotation TSV"
```

---

### Task 6: Add the Typed Native Bridge and Testable Project Store

**Files:**
- Create: `src/lib/bridge/native.ts`
- Create: `src/lib/state/projectStore.ts`
- Create: `src/lib/state/projectStore.test.ts`

**Interfaces:**
- Consumes: Task 2 domain types, Task 3 validation, and Task 5 Tauri commands.
- Produces: `NativeBridge`, `tauriBridge`, `ProjectStore`, `commitDraft()`, `selectAnnotation()`, `removeAnnotation()`, and debounced draft recovery.

- [ ] **Step 1: Define the typed bridge contract**

Create `src/lib/bridge/native.ts`:

```ts
import { invoke } from '@tauri-apps/api/core';
import type { MultilinePolicy, Project } from '../domain/types';

export interface ImportedAnnotation {
  startMs: number; endMs: number; eventType: 'speech' | 'non_speech'; transcription: string;
  intelligibility: 'intelligible' | 'partially_intelligible' | 'unintelligible' | 'not_applicable';
  speaker: string | null; overlap: 'none' | 'overlap'; confidence: 'high' | 'medium' | 'low';
  acousticTags: string[]; notes: string;
}
export interface ImportedTsv { annotations: ImportedAnnotation[]; speakers: string[]; acousticTags: string[] }
export interface NativeBridge {
  saveProject(project: Project): Promise<void>;
  loadProject(canonicalAudioPath: string): Promise<Project | null>;
  readTsv(path: string, multilinePolicy: MultilinePolicy): Promise<ImportedTsv>;
  writeTsv(path: string, project: Project): Promise<void>;
}
export const tauriBridge: NativeBridge = {
  saveProject: (project) => invoke('save_project', { project }),
  loadProject: (canonicalAudioPath) => invoke('load_project', { canonicalAudioPath }),
  readTsv: (path, multilinePolicy) => invoke('read_tsv', { path, multilinePolicy }),
  writeTsv: (path, project) => invoke('write_tsv', { path, project })
};
```

- [ ] **Step 2: Write failing store tests for explicit Add/Update and debounced draft recovery**

Create `src/lib/state/projectStore.test.ts`:

```ts
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../domain/project';
import { ProjectStore } from './projectStore';

const audio = { canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 };

describe('ProjectStore', () => {
  const bridge = { saveProject: vi.fn(async () => undefined) };
  beforeEach(() => { bridge.saveProject.mockClear(); vi.useFakeTimers(); });

  it('adds then updates the same annotation identity', async () => {
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'one' });
    await store.commitDraft('2026-01-01T00:00:00Z');
    const id = get(store).project!.annotations[0].id;
    store.patchDraft({ transcription: 'two' });
    await store.commitDraft('2026-01-01T00:00:01Z');
    expect(get(store).project!.annotations).toHaveLength(1);
    expect(get(store).project!.annotations[0]).toMatchObject({ id, transcription: 'two' });
  });

  it('persists a draft after the recovery debounce', async () => {
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.patchDraft({ notes: 'recover me' });
    await vi.advanceTimersByTimeAsync(350);
    expect(bridge.saveProject).toHaveBeenCalledTimes(1);
  });

  it('flushes a pending recovery write before close', async () => {
    const store = new ProjectStore(bridge);
    store.open(createProject(audio));
    store.patchDraft({ notes: 'close safely' });
    await store.flush();
    expect(bridge.saveProject).toHaveBeenCalledTimes(1);
  });

  it('removes an annotation and clears it from the editor', async () => {
    const store = new ProjectStore(bridge, () => 'event-1');
    store.open(createProject(audio));
    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'remove me' });
    await store.commitDraft('2026-01-01T00:00:00Z');
    await store.removeAnnotation('event-1');
    expect(get(store).project!.annotations).toEqual([]);
    expect(get(store).project!.activeAnnotationId).toBeNull();
  });
});
```

- [ ] **Step 3: Run the store tests and verify the missing class fails**

Run: `bun test src/lib/state/projectStore.test.ts`  
Expected: FAIL because `ProjectStore` does not exist.

- [ ] **Step 4: Implement the project store**

Create `src/lib/state/projectStore.ts`:

```ts
import { get, writable, type Readable } from 'svelte/store';
import { emptyDraft } from '../domain/project';
import type { Annotation, AnnotationDraft, Project, Selection } from '../domain/types';
import { validateDraft, type FieldErrors } from '../domain/validation';

interface SaveBridge { saveProject(project: Project): Promise<void> }
export interface ProjectState { project: Project | null; errors: FieldErrors; saveError: string | null }

export class ProjectStore implements Readable<ProjectState> {
  private readonly state = writable<ProjectState>({ project: null, errors: {}, saveError: null });
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  readonly subscribe = this.state.subscribe;
  constructor(private readonly bridge: SaveBridge, private readonly id = () => crypto.randomUUID()) {}

  open(project: Project): void { this.state.set({ project, errors: {}, saveError: null }); }

  patchDraft(patch: Partial<AnnotationDraft>): void {
    this.updateProject((project) => ({ ...project, draft: { ...project.draft, ...patch } }));
    this.scheduleRecovery();
  }

  setSelection(selection: Selection | null): void {
    this.updateProject((project) => ({
      ...project, activeSelection: selection,
      draft: selection ? { ...project.draft, ...selection } : project.draft
    }));
    this.scheduleRecovery();
  }

  selectAnnotation(id: string): void {
    this.updateProject((project) => {
      const annotation = project.annotations.find((item) => item.id === id);
      if (!annotation) return project;
      const draft: AnnotationDraft = {
        startMs: annotation.startMs, endMs: annotation.endMs, eventType: annotation.eventType,
        transcription: annotation.transcription, intelligibility: annotation.intelligibility,
        speakerId: annotation.speakerId, overlap: annotation.overlap, confidence: annotation.confidence,
        acousticTagIds: [...annotation.acousticTagIds], notes: annotation.notes
      };
      return { ...project, activeAnnotationId: id, activeSelection: { startMs: annotation.startMs, endMs: annotation.endMs }, draft };
    });
  }

  async removeAnnotation(id: string): Promise<void> {
    const current = get(this.state).project;
    if (!current) return;
    const wasActive = current.activeAnnotationId === id;
    const project: Project = {
      ...current,
      annotations: current.annotations.filter((item) => item.id !== id),
      activeAnnotationId: wasActive ? null : current.activeAnnotationId,
      activeSelection: wasActive ? null : current.activeSelection,
      draft: wasActive ? { ...emptyDraft(), speakerId: current.speakers[0]?.id ?? null } : current.draft
    };
    this.state.set({ project, errors: {}, saveError: null });
    await this.persist(project);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const project = get(this.state).project;
    if (project) await this.persist(project);
  }

  clearDraft(): void {
    this.updateProject((project) => ({ ...project, activeAnnotationId: null, activeSelection: null, draft: { ...emptyDraft(), speakerId: project.speakers[0]?.id ?? null } }));
  }

  async commitDraft(now = new Date().toISOString()): Promise<boolean> {
    const current = get(this.state);
    if (!current.project) return false;
    const errors = validateDraft(current.project.draft, current.project);
    if (Object.keys(errors).length) { this.state.update((value) => ({ ...value, errors })); return false; }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const active = current.project.annotations.find((item) => item.id === current.project!.activeAnnotationId);
    const annotation: Annotation = {
      ...current.project.draft,
      id: active?.id ?? this.id(), createdAt: active?.createdAt ?? now, updatedAt: now
    };
    const annotations = active
      ? current.project.annotations.map((item) => item.id === active.id ? annotation : item)
      : [...current.project.annotations, annotation];
    const project = { ...current.project, annotations, activeAnnotationId: annotation.id };
    this.state.set({ project, errors: {}, saveError: null });
    await this.persist(project);
    return true;
  }

  private updateProject(update: (project: Project) => Project): void {
    this.state.update((value) => value.project ? { ...value, project: update(value.project), errors: {} } : value);
  }
  private scheduleRecovery(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { const project = get(this.state).project; if (project) void this.persist(project); }, 300);
  }
  private async persist(project: Project): Promise<void> {
    try { await this.bridge.saveProject(project); }
    catch (error) { this.state.update((value) => ({ ...value, saveError: String(error) })); }
  }
}
```

- [ ] **Step 5: Run frontend verification and commit**

```powershell
bun test src/lib/state/projectStore.test.ts
bun run check
git add src/lib/bridge src/lib/state
git commit -m "feat: orchestrate annotation project state"
```

---

### Task 7: Build the Annotation Dashboard and Ordered Annotation Table

**Files:**
- Create: `src/lib/components/AnnotationDashboard.svelte`
- Create: `src/lib/components/AnnotationDashboard.test.ts`
- Create: `src/lib/components/AnnotationTable.svelte`
- Create: `src/lib/components/AnnotationTable.test.ts`

**Interfaces:**
- Consumes: `ProjectStore`, `formatTime()`, and controlled values from Tasks 2, 3, and 6.
- Produces: the complete annotation form, IME-safe Enter Add/Update, Shift+Enter multiline editing, and chronological row selection.

- [ ] **Step 1: Write failing keyboard and row-selection component tests**

Create `src/lib/components/AnnotationDashboard.test.ts`:

```ts
import { fireEvent, render, screen } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { createProject } from '../domain/project';
import { ProjectStore } from '../state/projectStore';
import AnnotationDashboard from './AnnotationDashboard.svelte';

function setup() {
  const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) }, () => 'event-1');
  store.open(createProject({ canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 }));
  store.patchDraft({ startMs: 10, endMs: 20, transcription: 'うん' });
  render(AnnotationDashboard, { store });
  return store;
}

describe('AnnotationDashboard', () => {
  it('submits with Enter but not Shift+Enter', async () => {
    const store = setup();
    const editor = screen.getByLabelText('Transcription');
    await fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
    expect(get(store).project!.annotations).toHaveLength(0);
    await fireEvent.keyDown(editor, { key: 'Enter' });
    expect(get(store).project!.annotations).toHaveLength(1);
  });

  it('does not submit an IME composition confirmation', async () => {
    const store = setup();
    await fireEvent.keyDown(screen.getByLabelText('Transcription'), { key: 'Enter', isComposing: true });
    expect(get(store).project!.annotations).toHaveLength(0);
  });
});
```

Create `src/lib/components/AnnotationTable.test.ts`:

```ts
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AnnotationTable from './AnnotationTable.svelte';

describe('AnnotationTable', () => {
  it('orders rows by start and preserves overlapping events', async () => {
    const select = vi.fn();
    const remove = vi.fn();
    render(AnnotationTable, {
      annotations: [
        { id: 'later', startMs: 20, endMs: 40, transcription: 'later', speaker: 'speaker_2' },
        { id: 'first', startMs: 10, endMs: 30, transcription: 'first', speaker: 'speaker_1' }
      ], activeId: null, onselect: select, onremove: remove
    });
    const rows = screen.getAllByRole('button', { name: /Edit annotation/ });
    expect(rows[0]).toHaveTextContent('first');
    await fireEvent.click(rows[1]);
    expect(select).toHaveBeenCalledWith('later');
    await fireEvent.click(screen.getByRole('button', { name: 'Remove annotation first' }));
    expect(remove).toHaveBeenCalledWith('first');
  });
});
```

- [ ] **Step 2: Run component tests and verify missing components fail**

Run: `bun test src/lib/components/AnnotationDashboard.test.ts src/lib/components/AnnotationTable.test.ts`  
Expected: FAIL with module-resolution errors for both components.

- [ ] **Step 3: Implement the editor with conditional fields and key handling**

Create `src/lib/components/AnnotationDashboard.svelte`:

```svelte
<script lang="ts">
  import type { ProjectStore } from '../state/projectStore';
  import { normalizeDraftForEventType } from '../domain/validation';
  import { formatTime } from '../domain/time';
  import type { EventType } from '../domain/types';

  export let store: ProjectStore;
  const submit = () => void store.commitDraft();
  function onEditorKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submit();
  }
  function eventTypeChanged(event: Event) {
    const project = $store.project;
    if (!project) return;
    store.patchDraft(normalizeDraftForEventType(project.draft, (event.currentTarget as HTMLSelectElement).value as EventType));
  }
</script>

{#if $store.project}
  {@const project = $store.project}
  <section class="annotation-dashboard" aria-label="Annotation dashboard">
    <div class="boundary-grid">
      <label>Start <output aria-label="Loop start time">{formatTime(project.draft.startMs, project.displayFormat)}</output><input aria-label="Start milliseconds" type="number" min="0" max={project.audioIdentity.durationMs} value={project.draft.startMs} on:input={(e) => store.patchDraft({ startMs: +(e.currentTarget as HTMLInputElement).value })} /></label>
      <label>End <output aria-label="Loop end time">{formatTime(project.draft.endMs, project.displayFormat)}</output><input aria-label="End milliseconds" type="number" min="1" max={project.audioIdentity.durationMs} value={project.draft.endMs} on:input={(e) => store.patchDraft({ endMs: +(e.currentTarget as HTMLInputElement).value })} /></label>
    </div>
    <label>Event type
      <select value={project.draft.eventType} on:change={eventTypeChanged}>
        <option value="speech">speech</option><option value="non_speech">non_speech</option>
      </select>
    </label>
    <label>Speaker
      <select disabled={project.draft.eventType === 'non_speech'} value={project.draft.speakerId ?? ''} on:change={(e) => store.patchDraft({ speakerId: (e.currentTarget as HTMLSelectElement).value || null })}>
        {#if project.draft.eventType === 'non_speech'}<option value="">none</option>{/if}
        {#each project.speakers as speaker}<option value={speaker.id}>{speaker.label}</option>{/each}
      </select>
    </label>
    <label>Transcription
      <textarea aria-label="Transcription" rows="5" value={project.draft.transcription} on:input={(e) => store.patchDraft({ transcription: (e.currentTarget as HTMLTextAreaElement).value })} on:keydown={onEditorKeydown}></textarea>
    </label>
    <div class="metadata-grid">
      <label>Intelligibility<select value={project.draft.intelligibility} on:change={(e) => store.patchDraft({ intelligibility: (e.currentTarget as HTMLSelectElement).value as typeof project.draft.intelligibility })}>
        <option>intelligible</option><option>partially_intelligible</option><option>unintelligible</option><option>not_applicable</option>
      </select></label>
      <label>Overlap<select value={project.draft.overlap} on:change={(e) => store.patchDraft({ overlap: (e.currentTarget as HTMLSelectElement).value as typeof project.draft.overlap })}><option>none</option><option>overlap</option></select></label>
      <label>Confidence<select value={project.draft.confidence} on:change={(e) => store.patchDraft({ confidence: (e.currentTarget as HTMLSelectElement).value as typeof project.draft.confidence })}><option>high</option><option>medium</option><option>low</option></select></label>
    </div>
    <fieldset><legend>Acoustic tags</legend>
      {#each project.acousticTags as tag}
        <label><input type="checkbox" checked={project.draft.acousticTagIds.includes(tag.id)} on:change={(e) => store.patchDraft({ acousticTagIds: (e.currentTarget as HTMLInputElement).checked ? [...project.draft.acousticTagIds, tag.id] : project.draft.acousticTagIds.filter((id) => id !== tag.id) })} />{tag.label}</label>
      {/each}
    </fieldset>
    <label>Notes<textarea aria-label="Notes" rows="3" value={project.draft.notes} on:input={(e) => store.patchDraft({ notes: (e.currentTarget as HTMLTextAreaElement).value })} on:keydown={onEditorKeydown}></textarea></label>
    {#if Object.keys($store.errors).length}<div role="alert">Correct the highlighted annotation fields.</div>{/if}
    <div class="actions"><button type="button" on:click={submit}>{project.activeAnnotationId ? 'Update annotation' : 'Add annotation'}</button><button type="button" on:click={() => store.clearDraft()}>Clear</button></div>
  </section>
{/if}
```

- [ ] **Step 4: Implement the ordered table**

Create `src/lib/components/AnnotationTable.svelte`:

```svelte
<script lang="ts">
  export let annotations: { id: string; startMs: number; endMs: number; transcription: string; speaker: string }[] = [];
  export let activeId: string | null = null;
  export let onselect: (id: string) => void;
  export let onremove: (id: string) => void;
  $: ordered = [...annotations].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
</script>

<section aria-label="Saved annotations" class="annotation-table">
  {#each ordered as annotation}
    <div class:active={annotation.id === activeId} class="annotation-row">
      <button type="button" aria-label={`Edit annotation ${annotation.transcription || annotation.id}`} on:click={() => onselect(annotation.id)}>
        <span>{(annotation.startMs / 1000).toFixed(3)}–{(annotation.endMs / 1000).toFixed(3)}</span>
        <span>{annotation.speaker}</span><span>{annotation.transcription || '—'}</span>
      </button>
      <button type="button" aria-label={`Remove annotation ${annotation.transcription || annotation.id}`} on:click={() => onremove(annotation.id)}>Remove</button>
    </div>
  {/each}
</section>
```

- [ ] **Step 5: Run tests, checks, and commit**

```powershell
bun test src/lib/components
bun run check
git add src/lib/components
git commit -m "feat: add structured annotation editor"
```

---

### Task 8: Add Speaker and Acoustic-Tag Management Components

**Files:**
- Create: `src/lib/components/SpeakerManager.svelte`
- Create: `src/lib/components/AcousticTagManager.svelte`
- Create: `src/lib/components/LabelManager.test.ts`
- Modify: `src/lib/state/projectStore.ts`
- Modify: `src/lib/components/AnnotationDashboard.svelte`

**Interfaces:**
- Consumes: Task 3 immutable label mutations and Task 6 project persistence.
- Produces: `mutateProject()` on `ProjectStore`, inline add/rename/remove UI, speaker reassignment, and referenced-tag confirmation.

- [ ] **Step 1: Add a store mutation method with committed persistence**

Add to `ProjectStore`:

```ts
async mutateProject(mutation: (project: Project) => Project): Promise<boolean> {
  const current = get(this.state).project;
  if (!current) return false;
  try {
    const project = mutation(current);
    this.state.set({ project, errors: {}, saveError: null });
    await this.persist(project);
    return true;
  } catch (error) {
    this.state.update((value) => ({ ...value, saveError: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}
```

- [ ] **Step 2: Write a failing component test for add and rename**

Create `src/lib/components/LabelManager.test.ts`:

```ts
import { fireEvent, render, screen } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { createProject } from '../domain/project';
import { ProjectStore } from '../state/projectStore';
import SpeakerManager from './SpeakerManager.svelte';

describe('SpeakerManager', () => {
  it('adds and renames a speaker', async () => {
    const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) });
    store.open(createProject({ canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 }));
    render(SpeakerManager, { store });
    await fireEvent.input(screen.getByLabelText('New speaker'), { target: { value: 'narrator' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add speaker' }));
    expect(get(store).project!.speakers.at(-1)?.label).toBe('narrator');
    const rename = screen.getByDisplayValue('narrator');
    await fireEvent.input(rename, { target: { value: 'host' } });
    await fireEvent.blur(rename);
    expect(get(store).project!.speakers.at(-1)?.label).toBe('host');
  });

  it('requires an explicit replacement before removing a referenced speaker', async () => {
    const store = new ProjectStore({ saveProject: vi.fn(async () => undefined) }, () => 'event-1');
    store.open(createProject({ canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 }));
    store.patchDraft({ startMs: 10, endMs: 20, transcription: 'line' });
    await store.commitDraft();
    render(SpeakerManager, { store });
    const remove = screen.getByRole('button', { name: 'Remove speaker_1' });
    expect(remove).toBeDisabled();
    const replacement = get(store).project!.speakers[1];
    await fireEvent.change(screen.getByLabelText('Reassign speaker_1'), { target: { value: replacement.id } });
    await fireEvent.click(remove);
    expect(get(store).project!.annotations[0].speakerId).toBe(replacement.id);
  });
});
```

- [ ] **Step 3: Run the test and verify the missing component fails**

Run: `bun test src/lib/components/LabelManager.test.ts`  
Expected: FAIL because `SpeakerManager.svelte` does not exist.

- [ ] **Step 4: Implement both focused managers**

Create `src/lib/components/SpeakerManager.svelte`:

```svelte
<script lang="ts">
  import type { ProjectStore } from '../state/projectStore';
  import { addLabel, removeSpeaker, renameSpeaker } from '../domain/project';
  export let store: ProjectStore;
  let nextLabel = '';
  let replacements: Record<string, string> = {};
  const add = async () => { await store.mutateProject((project) => addLabel(project, 'speakers', nextLabel)); nextLabel = ''; };
  const remove = async (id: string) => {
    const project = $store.project!;
    const referenced = project.annotations.some((item) => item.speakerId === id);
    const target = referenced ? replacements[id] : undefined;
    if (referenced && !target) return;
    await store.mutateProject((value) => removeSpeaker(value, id, target));
  };
</script>
{#if $store.project}<section aria-label="Speaker manager">
  {#each $store.project.speakers as speaker}
    {@const referenced = $store.project.annotations.some((item) => item.speakerId === speaker.id) || $store.project.draft.speakerId === speaker.id}
    <div>
      <input aria-label={`Rename ${speaker.label}`} value={speaker.label} on:blur={(e) => store.mutateProject((project) => renameSpeaker(project, speaker.id, (e.currentTarget as HTMLInputElement).value))} />
      {#if referenced}
        <select aria-label={`Reassign ${speaker.label}`} value={replacements[speaker.id] ?? ''} on:change={(e) => replacements = { ...replacements, [speaker.id]: (e.currentTarget as HTMLSelectElement).value }}>
          <option value="">Choose replacement</option>
          {#each $store.project.speakers.filter((item) => item.id !== speaker.id) as alternative}<option value={alternative.id}>{alternative.label}</option>{/each}
        </select>
      {/if}
      <button type="button" disabled={referenced && !replacements[speaker.id]} on:click={() => remove(speaker.id)}>Remove {speaker.label}</button>
    </div>
  {/each}
  <input aria-label="New speaker" bind:value={nextLabel} /><button type="button" on:click={add}>Add speaker</button>
</section>{/if}
```

Create `src/lib/components/AcousticTagManager.svelte`:

```svelte
<script lang="ts">
  import type { ProjectStore } from '../state/projectStore';
  import { addLabel, removeTag, renameTag } from '../domain/project';
  export let store: ProjectStore;
  let nextLabel = '';
  const add = async () => { await store.mutateProject((project) => addLabel(project, 'acousticTags', nextLabel)); nextLabel = ''; };
  const remove = async (id: string) => {
    const referenced = $store.project!.annotations.some((item) => item.acousticTagIds.includes(id));
    if (referenced && !window.confirm('Remove this tag from every affected annotation?')) return;
    await store.mutateProject((project) => removeTag(project, id, true));
  };
</script>
{#if $store.project}<section aria-label="Acoustic tag manager">
  {#each $store.project.acousticTags as tag}
    <div><input aria-label={`Rename ${tag.label}`} value={tag.label} on:blur={(e) => store.mutateProject((project) => renameTag(project, tag.id, (e.currentTarget as HTMLInputElement).value))} /><button type="button" on:click={() => remove(tag.id)}>Remove {tag.label}</button></div>
  {/each}
  <input aria-label="New acoustic tag" bind:value={nextLabel} /><button type="button" on:click={add}>Add acoustic tag</button>
</section>{/if}
```

Render both managers from `AnnotationDashboard.svelte` beneath their corresponding selectors.

- [ ] **Step 5: Run verification and commit**

```powershell
bun test src/lib/components
bun run check
git add src/lib/components src/lib/state/projectStore.ts
git commit -m "feat: manage project speakers and acoustic tags"
```

---

### Task 9: Build Timeline Math, Rulers, Selection Bar, and Ctrl+Wheel Zoom

**Files:**
- Create: `src/lib/domain/timeline.ts`
- Create: `src/lib/domain/timeline.test.ts`
- Create: `src/lib/components/TimeRuler.svelte`
- Create: `src/lib/components/LoopSelectionBar.svelte`
- Create: `src/lib/components/TimelineWorkspace.svelte`
- Create: `src/lib/components/TimelineWorkspace.test.ts`

**Interfaces:**
- Consumes: `Selection`, `formatTime()`, and `ProjectStore`.
- Produces: `ZoomState`, `zoomAtPointer()`, synchronized top/bottom rulers, draggable range body/handles, and Ctrl+wheel behavior.

- [ ] **Step 1: Write failing pointer-centered zoom tests**

Create `src/lib/domain/timeline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { zoomAtPointer } from './timeline';

describe('zoomAtPointer', () => {
  it('keeps the time under the pointer fixed', () => {
    const next = zoomAtPointer({ pixelsPerSecond: 100, scrollLeft: 100, viewportWidth: 500 }, -100, 250, 10_000);
    expect(next.pixelsPerSecond).toBe(125);
    expect(next.scrollLeft).toBeCloseTo(187.5);
  });

  it('never zooms out past fitting the entire clip', () => {
    const next = zoomAtPointer({ pixelsPerSecond: 100, scrollLeft: 0, viewportWidth: 500 }, 100, 250, 2_000);
    expect(next.pixelsPerSecond).toBe(250);
  });
});
```

- [ ] **Step 2: Run the math test and verify it fails**

Run: `bun test src/lib/domain/timeline.test.ts`  
Expected: FAIL because `timeline.ts` does not exist.

- [ ] **Step 3: Implement bounded pointer-centered zoom and tick generation**

Create `src/lib/domain/timeline.ts`:

```ts
export interface ZoomState { pixelsPerSecond: number; scrollLeft: number; viewportWidth: number }

export function zoomAtPointer(state: ZoomState, deltaY: number, pointerX: number, durationMs: number): ZoomState {
  const durationSeconds = durationMs / 1000;
  const minimum = state.viewportWidth / durationSeconds;
  const maximum = 1000;
  const factor = deltaY < 0 ? 1.25 : 0.8;
  const pixelsPerSecond = Math.min(maximum, Math.max(minimum, state.pixelsPerSecond * factor));
  const anchorSeconds = (state.scrollLeft + pointerX) / state.pixelsPerSecond;
  const contentWidth = durationSeconds * pixelsPerSecond;
  const scrollLeft = Math.min(Math.max(0, anchorSeconds * pixelsPerSecond - pointerX), Math.max(0, contentWidth - state.viewportWidth));
  return { ...state, pixelsPerSecond, scrollLeft };
}

export function rulerTicks(durationMs: number, pixelsPerSecond: number): number[] {
  const candidateSeconds = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60];
  const step = candidateSeconds.find((seconds) => seconds * pixelsPerSecond >= 70) ?? 120;
  const ticks: number[] = [];
  for (let seconds = 0; seconds * 1000 <= durationMs; seconds += step) ticks.push(Math.round(seconds * 1000));
  return ticks;
}
```

- [ ] **Step 4: Implement the ruler and draggable selection bar**

Create `src/lib/components/TimeRuler.svelte`:

```svelte
<script lang="ts">
  import { formatTime } from '../domain/time';
  import { rulerTicks } from '../domain/timeline';
  import type { TimeDisplayFormat } from '../domain/types';
  export let durationMs: number; export let pixelsPerSecond: number; export let format: TimeDisplayFormat;
  $: ticks = rulerTicks(durationMs, pixelsPerSecond);
</script>
<div class="time-ruler" style:width={`${durationMs / 1000 * pixelsPerSecond}px`}>
  {#each ticks as tick}<span class="tick" style:left={`${tick / 1000 * pixelsPerSecond}px`}>{formatTime(tick, format)}</span>{/each}
</div>
```

Create `src/lib/components/LoopSelectionBar.svelte`:

```svelte
<script lang="ts">
  import type { Selection } from '../domain/types';
  export let selection: Selection | null; export let durationMs: number; export let pixelsPerSecond: number;
  export let onchange: (selection: Selection) => void;
  let drag: { kind: 'start' | 'end' | 'body'; x: number; initial: Selection } | null = null;
  const down = (event: PointerEvent, kind: 'start' | 'end' | 'body') => {
    if (!selection) return; (event.currentTarget as Element).setPointerCapture(event.pointerId);
    drag = { kind, x: event.clientX, initial: { ...selection } };
  };
  const move = (event: PointerEvent) => {
    if (!drag) return; const delta = Math.round((event.clientX - drag.x) / pixelsPerSecond * 1000);
    if (drag.kind === 'start') onchange({ startMs: Math.min(drag.initial.endMs - 1, Math.max(0, drag.initial.startMs + delta)), endMs: drag.initial.endMs });
    else if (drag.kind === 'end') onchange({ startMs: drag.initial.startMs, endMs: Math.max(drag.initial.startMs + 1, Math.min(durationMs, drag.initial.endMs + delta)) });
    else { const width = drag.initial.endMs - drag.initial.startMs; const startMs = Math.min(durationMs - width, Math.max(0, drag.initial.startMs + delta)); onchange({ startMs, endMs: startMs + width }); }
  };
</script>
<div class="selection-track" on:pointermove={move} on:pointerup={() => drag = null}>
  {#if selection}<div class="selection" style:left={`${selection.startMs / 1000 * pixelsPerSecond}px`} style:width={`${(selection.endMs - selection.startMs) / 1000 * pixelsPerSecond}px`}>
    <button aria-label="Resize loop start" class="handle start" on:pointerdown={(e) => down(e, 'start')}></button>
    <button aria-label="Move loop selection" class="body" on:pointerdown={(e) => down(e, 'body')}></button>
    <button aria-label="Resize loop end" class="handle end" on:pointerdown={(e) => down(e, 'end')}></button>
  </div>{/if}
</div>
```

- [ ] **Step 5: Write the failing Ctrl+wheel workspace test**

Create `src/lib/components/TimelineWorkspace.test.ts`:

```ts
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import TimelineWorkspace from './TimelineWorkspace.svelte';

describe('TimelineWorkspace', () => {
  it('zooms only for Ctrl+wheel and prevents page zoom', async () => {
    const change = vi.fn();
    render(TimelineWorkspace, { durationMs: 10_000, format: 'seconds', selection: { startMs: 100, endMs: 200 }, onchange: change });
    const viewport = screen.getByTestId('timeline-viewport');
    Object.defineProperty(viewport, 'clientWidth', { value: 500 });
    const event = new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, clientX: 250, bubbles: true, cancelable: true });
    viewport.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId('timeline-content').style.width).toBe('1250px');
  });
});
```

- [ ] **Step 6: Implement the shared timeline viewport in the required order**

Create `src/lib/components/TimelineWorkspace.svelte`:

```svelte
<script lang="ts">
  import type { Selection, TimeDisplayFormat } from '../domain/types';
  import { zoomAtPointer } from '../domain/timeline';
  import TimeRuler from './TimeRuler.svelte';
  import LoopSelectionBar from './LoopSelectionBar.svelte';
  export let durationMs: number; export let format: TimeDisplayFormat; export let selection: Selection | null;
  export let onchange: (selection: Selection) => void;
  let viewport: HTMLDivElement; let pixelsPerSecond = 100; let scrollLeft = 0;
  $: contentWidth = durationMs / 1000 * pixelsPerSecond;
  function wheel(event: WheelEvent) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const next = zoomAtPointer({ pixelsPerSecond, scrollLeft: viewport.scrollLeft, viewportWidth: viewport.clientWidth }, event.deltaY, event.clientX - rect.left, durationMs);
    pixelsPerSecond = next.pixelsPerSecond; scrollLeft = next.scrollLeft;
    requestAnimationFrame(() => { viewport.scrollLeft = scrollLeft; });
  }
</script>
<div class="timeline-viewport" data-testid="timeline-viewport" bind:this={viewport} on:wheel={wheel}>
  <div class="timeline-content" data-testid="timeline-content" style:width={`${contentWidth}px`}>
    <TimeRuler {durationMs} {pixelsPerSecond} {format} />
    <LoopSelectionBar {selection} {durationMs} {pixelsPerSecond} {onchange} />
    <div class="waveform-slot"><slot name="waveform" /></div>
    <TimeRuler {durationMs} {pixelsPerSecond} {format} />
  </div>
</div>
```

- [ ] **Step 7: Run frontend verification and commit**

```powershell
bun test src/lib/domain/timeline.test.ts src/lib/components/TimelineWorkspace.test.ts
bun run check
git add src/lib/domain/timeline* src/lib/components/TimeRuler.svelte src/lib/components/LoopSelectionBar.svelte src/lib/components/TimelineWorkspace*
git commit -m "feat: add synchronized zoomable timeline"
```

---

### Task 10: Isolate WaveSurfer Rendering and Active-Region Synchronization

**Files:**
- Create: `src/lib/waveform/wavesurferAdapter.ts`
- Create: `src/lib/waveform/wavesurferAdapter.test.ts`
- Create: `src/lib/components/WaveformView.svelte`
- Modify: `src/lib/components/TimelineWorkspace.svelte`

**Interfaces:**
- Consumes: precomputed `PeakData`, duration, zoom, playhead, and canonical `Selection`.
- Produces: `WaveformAdapter`, `createWaveformAdapter()`, mouse drag selection, region highlighting, and visual playhead updates without media playback.

- [ ] **Step 1: Define the peak wire type on the frontend bridge**

Add to `src/lib/bridge/native.ts`:

```ts
export interface PeakData {
  durationMs: number;
  sampleRate: number;
  framesPerPeak: number;
  channels: number[][];
}
export interface AnalysisProgress { processedMs: number; durationMs: number }
```

- [ ] **Step 2: Write a failing adapter contract test using an injected WaveSurfer factory**

Create `src/lib/waveform/wavesurferAdapter.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createWaveformAdapter } from './wavesurferAdapter';

describe('createWaveformAdapter', () => {
  it('updates one visual region and reports integer millisecond edits', () => {
    const region = { setOptions: vi.fn() };
    const regions = { clearRegions: vi.fn(), addRegion: vi.fn(() => region), enableDragSelection: vi.fn(() => vi.fn()), on: vi.fn() };
    const wave = { registerPlugin: vi.fn(() => regions), setTime: vi.fn(), zoom: vi.fn(), destroy: vi.fn() };
    const changed = vi.fn();
    const adapter = createWaveformAdapter(document.createElement('div'), { durationMs: 1000, sampleRate: 1000, framesPerPeak: 10, channels: [[0, 1]] }, changed, () => wave as never);
    adapter.setSelection({ startMs: 100, endMs: 200 });
    expect(regions.addRegion).toHaveBeenCalledWith(expect.objectContaining({ start: 0.1, end: 0.2 }));
    adapter.setSelection({ startMs: 110, endMs: 210 });
    expect(region.setOptions).toHaveBeenCalledWith({ start: 0.11, end: 0.21 });
  });
});
```

- [ ] **Step 3: Run the test and verify the adapter is missing**

Run: `bun test src/lib/waveform/wavesurferAdapter.test.ts`  
Expected: FAIL because the adapter module does not exist.

- [ ] **Step 4: Implement the WaveSurfer adapter with playback disabled**

Create `src/lib/waveform/wavesurferAdapter.ts`:

```ts
import WaveSurfer from 'wavesurfer.js';
import Regions from 'wavesurfer.js/dist/plugins/regions.esm.js';
import type { PeakData } from '../bridge/native';
import type { Selection } from '../domain/types';

export interface WaveformAdapter {
  setSelection(selection: Selection | null): void;
  setPlayhead(milliseconds: number): void;
  setZoom(pixelsPerSecond: number): void;
  destroy(): void;
}

type Factory = (options: Parameters<typeof WaveSurfer.create>[0]) => WaveSurfer;

export function createWaveformAdapter(container: HTMLElement, peaks: PeakData, onchange: (selection: Selection) => void, factory: Factory = WaveSurfer.create): WaveformAdapter {
  const silentMedia = document.createElement('audio');
  const wave = factory({ container, peaks: peaks.channels, duration: peaks.durationMs / 1000, media: silentMedia, interact: true, dragToSeek: false, waveColor: '#66758a', progressColor: '#8ba8d8', cursorWidth: 0, normalize: true });
  const regions = wave.registerPlugin(Regions.create());
  let region: ReturnType<typeof regions.addRegion> | null = null;
  let syncing = false;
  const stopDrag = regions.enableDragSelection({ color: 'rgba(104, 164, 255, .28)', drag: true, resize: true });
  regions.on('region-created', (next) => {
    if (syncing) return;
    if (region && region !== next) region.remove();
    region = next;
    onchange({ startMs: Math.round(next.start * 1000), endMs: Math.round(next.end * 1000) });
  });
  regions.on('region-updated', (next) => { if (!syncing) onchange({ startMs: Math.round(next.start * 1000), endMs: Math.round(next.end * 1000) }); });
  return {
    setSelection(selection) {
      syncing = true;
      if (!selection) { regions.clearRegions(); region = null; }
      else if (region) region.setOptions({ start: selection.startMs / 1000, end: selection.endMs / 1000 });
      else region = regions.addRegion({ start: selection.startMs / 1000, end: selection.endMs / 1000, color: 'rgba(104, 164, 255, .28)', drag: true, resize: true });
      syncing = false;
    },
    setPlayhead(milliseconds) { wave.setTime(milliseconds / 1000); },
    setZoom(pixelsPerSecond) { wave.zoom(pixelsPerSecond); },
    destroy() { stopDrag(); wave.destroy(); }
  };
}
```

- [ ] **Step 5: Implement the Svelte lifecycle wrapper**

Create `src/lib/components/WaveformView.svelte`:

```svelte
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { PeakData } from '../bridge/native';
  import type { Selection } from '../domain/types';
  import { createWaveformAdapter, type WaveformAdapter } from '../waveform/wavesurferAdapter';
  export let peaks: PeakData; export let selection: Selection | null; export let playheadMs = 0; export let pixelsPerSecond = 100;
  export let onchange: (selection: Selection) => void;
  let container: HTMLDivElement; let adapter: WaveformAdapter | null = null;
  onMount(() => { adapter = createWaveformAdapter(container, peaks, onchange); adapter.setSelection(selection); });
  onDestroy(() => adapter?.destroy());
  $: adapter?.setSelection(selection);
  $: adapter?.setPlayhead(playheadMs);
  $: adapter?.setZoom(pixelsPerSecond);
</script>
<div class="waveform" bind:this={container} role="img" aria-label="Audio waveform"></div>
```

Modify `TimelineWorkspace.svelte` to own the waveform rendering so every layer uses the same zoom value:

```diff
+ import type { PeakData } from '../bridge/native';
+ import WaveformView from './WaveformView.svelte';
+ export let peaks: PeakData | null = null;
+ export let playheadMs = 0;

- <div class="waveform-slot"><slot name="waveform" /></div>
+ <div class="waveform-slot">
+   {#if peaks}<WaveformView {peaks} {selection} {playheadMs} {pixelsPerSecond} {onchange} />{/if}
+ </div>
```

The resulting markup at the replacement site is:

```svelte
<div class="waveform-slot">
  {#if peaks}<WaveformView {peaks} {selection} {playheadMs} {pixelsPerSecond} {onchange} />{/if}
</div>
```

Merge the added imports and props into the existing single `<script>` block; the second block above shows the exact additions, not a second runtime script. The silent, source-less `HTMLAudioElement` passed to WaveSurfer exists only to satisfy its renderer API and is never loaded or played.

- [ ] **Step 6: Run frontend verification and commit**

```powershell
bun test src/lib/waveform src/lib/components/TimelineWorkspace.test.ts
bun run check
git add src/lib/bridge/native.ts src/lib/waveform src/lib/components/WaveformView.svelte src/lib/components/TimelineWorkspace.svelte
git commit -m "feat: render synchronized waveform regions"
```

---

### Task 11: Probe Audio and Generate Cached Waveform Peaks in Rust

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/audio/mod.rs`
- Create: `src-tauri/src/audio/decoder.rs`
- Create: `src-tauri/src/audio/peaks.rs`
- Create: `src-tauri/tests/fixtures/decoder-smoke.mp3`
- Modify: `src-tauri/src/model.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/bridge/native.ts`

**Interfaces:**
- Consumes: explicit MP3/WAV paths and the application-data directory.
- Produces: `DecodedChunk`, `AudioDecoder`, `inspect_audio`, `analyze_audio`, `cancel_analysis`, `PeakData`, `AnalysisProgress`, and a cache keyed by canonical path, size, and modification time.

- [ ] **Step 1: Add decoding dependencies and a committed MP3 smoke fixture**

```powershell
Set-Location src-tauri
cargo add symphonia@0.6 --no-default-features --features wav,pcm,mpa
cargo add rtrb@0.3.4
cargo add --dev hound
Set-Location ..
New-Item -ItemType Directory -Force src-tauri\tests\fixtures | Out-Null
Invoke-WebRequest https://raw.githubusercontent.com/jiaaro/pydub/master/test/data/test1.mp3 -OutFile src-tauri\tests\fixtures\decoder-smoke.mp3
```

The fixture is checked into Git, so tests never require network access after this step.

- [ ] **Step 2: Write failing decoder probe and exact-seek tests**

Create the test module in `src-tauri/src/audio/decoder.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_the_committed_mp3_fixture() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/decoder-smoke.mp3");
        let decoder = AudioDecoder::open(&path).unwrap();
        assert!(decoder.identity().duration_ms > 0);
        assert!(decoder.identity().sample_rate > 0);
    }

    #[test]
    fn exact_seek_matches_the_same_frames_from_sequential_decode() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/decoder-smoke.mp3");
        let mut sequential = AudioDecoder::open(&path).unwrap();
        let decoded_from_zero = sequential.decode_range(0, 2_128).unwrap();
        let channels = decoded_from_zero.channels as usize;
        let expected = decoded_from_zero.interleaved[2_000 * channels..2_128 * channels].to_vec();
        let mut sought = AudioDecoder::open(&path).unwrap();
        let actual = sought.decode_range(2_000, 2_128).unwrap();
        assert_eq!(actual.start_frame, 2_000);
        assert_eq!(actual.interleaved.len(), expected.interleaved.len());
        for (left, right) in actual.interleaved.iter().zip(expected) {
            assert!((left - right).abs() < 1e-6);
        }
    }
}
```

- [ ] **Step 3: Run decoder tests and verify missing implementation fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml audio::decoder::tests`  
Expected: FAIL because `AudioDecoder` is undefined.

- [ ] **Step 4: Implement Symphonia probing and frame-addressed decoding**

Create `src-tauri/src/audio/mod.rs`:

```rust
pub mod decoder;
pub mod peaks;
```

Implement `src-tauri/src/audio/decoder.rs` around these exact public types and methods:

```rust
use crate::{error::AppError, model::AudioIdentity};
use std::{fs::File, path::Path};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{Decoder, DecoderOptions},
    formats::{FormatOptions, FormatReader, SeekMode, SeekTo},
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
    units::{Time, TimeBase},
};

pub struct DecodedChunk { pub start_frame: u64, pub channels: u16, pub interleaved: Vec<f32> }
pub struct AudioDecoder {
    format: Box<dyn FormatReader>, decoder: Box<dyn Decoder>, track_id: u32, time_base: TimeBase,
    identity: AudioIdentity, next_frame: u64, pending: Option<DecodedChunk>,
}

impl AudioDecoder {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
        if extension != "mp3" && extension != "wav" { return Err(AppError::Audio("Only MP3 and WAV files are supported".into())); }
        let canonical = path.canonicalize()?;
        let metadata = std::fs::metadata(&canonical)?;
        let modified_ms = metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|duration| duration.as_millis() as i64).unwrap_or_default();
        let mut hint = Hint::new(); hint.with_extension(&extension);
        let stream = MediaSourceStream::new(Box::new(File::open(&canonical)?), Default::default());
        let probed = symphonia::default::get_probe().format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
            .map_err(|error| AppError::Audio(error.to_string()))?;
        let format = probed.format;
        let track = format.default_track().ok_or_else(|| AppError::Audio("No audio track found".into()))?;
        let track_id = track.id;
        let params = track.codec_params.clone().ok_or_else(|| AppError::Audio("Audio codec parameters are unavailable".into()))?;
        let sample_rate = params.sample_rate.ok_or_else(|| AppError::Audio("Audio sample rate is unknown".into()))?;
        let channels = params.channels.map(|value| value.count() as u16).ok_or_else(|| AppError::Audio("Audio channel count is unknown".into()))?;
        let time_base = track.time_base.or_else(|| TimeBase::try_from_recip(sample_rate)).ok_or_else(|| AppError::Audio("Audio time base is unknown".into()))?;
        let duration_ms = track.duration.map(|duration| time_base.calc_time_saturating(duration).as_millis() as u64)
            .or_else(|| track.num_frames.map(|frames| frames.saturating_mul(1000) / sample_rate as u64))
            .ok_or_else(|| AppError::Audio("Audio duration is unknown".into()))?;
        if duration_ms > 30 * 60 * 1000 { return Err(AppError::Audio("Audio exceeds the 30-minute limit".into())); }
        let decoder = symphonia::default::get_codecs().make(&params, &DecoderOptions::default()).map_err(|error| AppError::Audio(error.to_string()))?;
        Ok(Self { track_id, time_base, format, decoder, next_frame: 0, pending: None, identity: AudioIdentity {
            canonical_path: canonical.to_string_lossy().into_owned(), size: metadata.len(), modified_ms,
            duration_ms, sample_rate, channels,
        }})
    }

    pub fn identity(&self) -> &AudioIdentity { &self.identity }

    fn timestamp_frame(&self, timestamp: u64) -> u64 {
        (self.time_base.calc_time_saturating(timestamp).as_secs_f64() * self.identity.sample_rate as f64).round() as u64
    }

    fn decode_packet(&mut self) -> Result<Option<DecodedChunk>, AppError> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(symphonia::core::errors::Error::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
                Err(error) => return Err(AppError::Audio(error.to_string())),
            };
            if packet.track_id() != self.track_id { continue; }
            let decoded = self.decoder.decode(&packet).map_err(|error| AppError::Audio(error.to_string()))?;
            let channels = decoded.spec().channels.count() as u16;
            let mut samples = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
            samples.copy_interleaved_ref(decoded);
            let start_frame = self.next_frame;
            self.next_frame += samples.samples().len() as u64 / channels as u64;
            return Ok(Some(DecodedChunk { start_frame, channels, interleaved: samples.samples().to_vec() }));
        }
    }

    pub fn seek_exact(&mut self, target_frame: u64) -> Result<(), AppError> {
        if target_frame > self.identity.duration_ms.saturating_mul(self.identity.sample_rate as u64) / 1000 {
            return Err(AppError::Audio("Seek exceeds audio duration".into()));
        }
        let nanos = target_frame as u128 * 1_000_000_000_u128 / self.identity.sample_rate as u128;
        let time = Time::try_from_nanos_u128(nanos).ok_or_else(|| AppError::Audio("Seek time overflow".into()))?;
        let sought = self.format.seek(SeekMode::Accurate, SeekTo::Time { time, track_id: Some(self.track_id) })
            .map_err(|error| AppError::Audio(error.to_string()))?;
        self.decoder.reset();
        self.pending = None;
        self.next_frame = self.timestamp_frame(sought.actual_ts);
        if self.next_frame > target_frame { return Err(AppError::Audio("Decoder seek passed the requested frame".into())); }
        loop {
            let chunk = self.decode_packet()?.ok_or_else(|| AppError::Audio("Seek reached end of audio".into()))?;
            let frames = chunk.interleaved.len() as u64 / chunk.channels as u64;
            let chunk_end = chunk.start_frame + frames;
            if target_frame >= chunk_end { continue; }
            if target_frame < chunk.start_frame { return Err(AppError::Audio("Decoder produced a gap after seek".into())); }
            let sample_offset = ((target_frame - chunk.start_frame) * chunk.channels as u64) as usize;
            self.pending = Some(DecodedChunk {
                start_frame: target_frame, channels: chunk.channels, interleaved: chunk.interleaved[sample_offset..].to_vec()
            });
            return Ok(());
        }
    }

    pub fn decode_next(&mut self) -> Result<Option<DecodedChunk>, AppError> {
        if self.pending.is_some() { return Ok(self.pending.take()); }
        self.decode_packet()
    }

    pub fn decode_range(&mut self, start_frame: u64, end_frame: u64) -> Result<DecodedChunk, AppError> {
        if end_frame <= start_frame { return Err(AppError::Audio("Decode range must be non-empty".into())); }
        self.seek_exact(start_frame)?;
        let channels = self.identity.channels;
        let wanted_samples = (end_frame - start_frame) as usize * channels as usize;
        let mut interleaved = Vec::with_capacity(wanted_samples);
        while interleaved.len() < wanted_samples {
            let chunk = self.decode_next()?.ok_or_else(|| AppError::Audio("Range exceeds audio".into()))?;
            let remaining = wanted_samples - interleaved.len();
            interleaved.extend_from_slice(&chunk.interleaved[..remaining.min(chunk.interleaved.len())]);
        }
        Ok(DecodedChunk { start_frame, channels, interleaved })
    }
}
```

This implementation deliberately keeps the partial packet tail in `pending`. `sought.actual_ts` is converted through the track `TimeBase` before it is compared with a PCM frame; it is never treated as a frame number directly.

- [ ] **Step 5: Write a failing bounded peak-generation test using a generated WAV**

Add to `src-tauri/src/audio/peaks.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creates_min_max_peaks_without_full_pcm_retention() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tone.wav");
        let spec = hound::WavSpec { channels: 1, sample_rate: 1000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for sample in [0_i16, 1000, -2000, 3000, 0, -4000, 2000, 0, 1000, -1000] { writer.write_sample(sample).unwrap(); }
        writer.finalize().unwrap();
        let peaks = analyze_path(&path, &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!(peaks.channels.len(), 1);
        assert!(peaks.channels[0].iter().all(|value| (-1.0..=1.0).contains(value)));
        assert!(peaks.frames_per_peak >= 1);
    }
}
```

- [ ] **Step 6: Implement peak wire types, streaming analysis, cache, progress, and cancellation**

Add to `src-tauri/src/model.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeakData { pub duration_ms: u64, pub sample_rate: u32, pub frames_per_peak: u32, pub channels: Vec<Vec<f32>> }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisProgress { pub processed_ms: u64, pub duration_ms: u64 }
```

Implement streaming analysis in `src-tauri/src/audio/peaks.rs`:

```rust
use crate::{
    audio::decoder::AudioDecoder,
    error::AppError,
    model::{AnalysisProgress, AudioIdentity, PeakData},
};
use atomic_write_file::AtomicWriteFile;
use std::{fs, io::Write, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}, time::{Duration, Instant}};

pub fn analyze_path(path: &Path, cancelled: &AtomicBool, mut progress: impl FnMut(AnalysisProgress)) -> Result<PeakData, AppError> {
    let mut decoder = AudioDecoder::open(path)?;
    let identity = decoder.identity().clone();
    let channels = identity.channels as usize;
    let frames_per_peak = (identity.sample_rate / 100).max(1);
    let mut output = vec![Vec::new(); channels];
    let mut minimum = vec![f32::INFINITY; channels];
    let mut maximum = vec![f32::NEG_INFINITY; channels];
    let mut bucket_frames = 0_u32;
    let mut processed_frames = 0_u64;
    let mut last_report = Instant::now() - Duration::from_millis(100);

    while let Some(chunk) = decoder.decode_next()? {
        if cancelled.load(Ordering::Acquire) { return Err(AppError::Audio("Waveform analysis cancelled".into())); }
        for frame in chunk.interleaved.chunks_exact(channels) {
            for (channel, sample) in frame.iter().enumerate() {
                minimum[channel] = minimum[channel].min(*sample);
                maximum[channel] = maximum[channel].max(*sample);
            }
            bucket_frames += 1;
            processed_frames += 1;
            if bucket_frames == frames_per_peak {
                for channel in 0..channels {
                    output[channel].push(minimum[channel].clamp(-1.0, 1.0));
                    output[channel].push(maximum[channel].clamp(-1.0, 1.0));
                    minimum[channel] = f32::INFINITY;
                    maximum[channel] = f32::NEG_INFINITY;
                }
                bucket_frames = 0;
            }
        }
        if last_report.elapsed() >= Duration::from_millis(100) {
            progress(AnalysisProgress { processed_ms: processed_frames.saturating_mul(1000) / identity.sample_rate as u64, duration_ms: identity.duration_ms });
            last_report = Instant::now();
        }
    }
    if bucket_frames > 0 {
        for channel in 0..channels {
            output[channel].push(minimum[channel].clamp(-1.0, 1.0));
            output[channel].push(maximum[channel].clamp(-1.0, 1.0));
        }
    }
    progress(AnalysisProgress { processed_ms: identity.duration_ms, duration_ms: identity.duration_ms });
    Ok(PeakData { duration_ms: identity.duration_ms, sample_rate: identity.sample_rate, frames_per_peak, channels: output })
}

pub fn cache_path(cache_dir: &Path, identity: &AudioIdentity) -> PathBuf {
    let material = format!("{}\0{}\0{}", identity.canonical_path, identity.size, identity.modified_ms);
    cache_dir.join(format!("{}.json", blake3::hash(material.as_bytes()).to_hex()))
}

pub fn read_cache(cache_dir: &Path, identity: &AudioIdentity) -> Result<Option<PeakData>, AppError> {
    let path = cache_path(cache_dir, identity);
    if !path.exists() { return Ok(None); }
    serde_json::from_slice(&fs::read(path)?).map(Some).map_err(|error| AppError::Audio(format!("Invalid waveform cache: {error}")))
}

pub fn write_cache(cache_dir: &Path, identity: &AudioIdentity, peaks: &PeakData) -> Result<(), AppError> {
    fs::create_dir_all(cache_dir)?;
    let mut file = AtomicWriteFile::options().open(cache_path(cache_dir, identity))?;
    file.write_all(&serde_json::to_vec(peaks).map_err(|error| AppError::Audio(error.to_string()))?)?;
    file.commit()?;
    Ok(())
}
```

The cache key includes the canonical path, file size, and modification time. Consequently, modified source audio cannot reuse stale peak data; malformed cache JSON is reported and can be regenerated after deleting only that cache entry.

Add managed cancellation and the async commands in `commands.rs`:

```rust
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};

#[derive(Default)]
pub struct AnalysisState { active: Mutex<Option<Arc<AtomicBool>>> }
impl AnalysisState {
    fn begin(&self) -> Result<Arc<AtomicBool>, AppError> {
        let mut active = self.active.lock().map_err(|_| AppError::Audio("Analysis state lock poisoned".into()))?;
        if let Some(previous) = active.replace(Arc::new(AtomicBool::new(false))) { previous.store(true, Ordering::Release); }
        Ok(active.as_ref().unwrap().clone())
    }
    fn cancel(&self) -> Result<(), AppError> {
        if let Some(active) = self.active.lock().map_err(|_| AppError::Audio("Analysis state lock poisoned".into()))?.as_ref() {
            active.store(true, Ordering::Release);
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn inspect_audio(path: String) -> Result<AudioIdentity, AppError> {
    tauri::async_runtime::spawn_blocking(move || AudioDecoder::open(Path::new(&path)).map(|decoder| decoder.identity().clone()))
        .await.map_err(|error| AppError::Audio(error.to_string()))?
}

#[tauri::command]
pub async fn analyze_audio(app: AppHandle, state: State<'_, AnalysisState>, path: String) -> Result<PeakData, AppError> {
    let cancelled = state.begin()?;
    let cache_dir = app_data(&app)?.join("cache");
    tauri::async_runtime::spawn_blocking(move || {
        let source = Path::new(&path);
        let identity = AudioDecoder::open(source)?.identity().clone();
        if let Some(cached) = peaks::read_cache(&cache_dir, &identity)? { return Ok::<PeakData, AppError>(cached); }
        let progress_app = app.clone();
        let data = peaks::analyze_path(source, &cancelled, |value| { let _ = progress_app.emit("analysis-progress", value); })?;
        peaks::write_cache(&cache_dir, &identity, &data)?;
        Ok::<PeakData, AppError>(data)
    }).await.map_err(|error| AppError::Audio(error.to_string()))?
}

#[tauri::command]
pub fn cancel_analysis(state: State<'_, AnalysisState>) -> Result<(), AppError> { state.cancel() }
```

Import `AtomicBool`, `Ordering`, `Path`, `AudioDecoder`, `peaks`, `AudioIdentity`, and `PeakData` into the command module. Call `.manage(AnalysisState::default())`, register all three commands, and extend `NativeBridge` with:

```ts
inspectAudio(path: string): Promise<AudioIdentity>;
analyzeAudio(path: string): Promise<PeakData>;
cancelAnalysis(): Promise<void>;
onAnalysisProgress(handler: (progress: AnalysisProgress) => void): Promise<() => void>;
```

Implement `onAnalysisProgress()` with `listen<AnalysisProgress>('analysis-progress', (event) => handler(event.payload))` from `@tauri-apps/api/event`, returning its unlisten function.

- [ ] **Step 7: Run complete decoder/peak verification and commit**

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml audio
bun run check
git add src-tauri src/lib/bridge/native.ts
git commit -m "feat: decode audio and cache waveform peaks"
```

---

### Task 12: Build and Prove the Sample-Counted Loop Core

**Files:**
- Create: `src-tauri/src/audio/loop_cursor.rs`
- Create: `src-tauri/src/audio/render.rs`
- Modify: `src-tauri/src/audio/mod.rs`

**Interfaces:**
- Consumes: decoded source-frame numbers and interleaved stereo PCM.
- Produces: `LoopRange`, `LoopCursor`, `QueuedFrame`, `RenderCore`, and a deterministic PCM-sequence test that enforces the 1 ms contract independently of hardware.

- [ ] **Step 1: Write failing frame-sequence and precision-contract tests**

Create `src-tauri/src/audio/loop_cursor.rs` with tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wraps_end_exclusive_to_the_exact_start_frame() {
        let mut cursor = LoopCursor::new(94, Some(LoopRange::new(48, 96).unwrap()));
        let frames = (0..5).map(|_| cursor.take()).collect::<Vec<_>>();
        assert_eq!(frames, vec![94, 95, 48, 49, 50]);
    }

    #[test]
    fn both_boundaries_are_within_one_millisecond_at_common_rates() {
        for sample_rate in [44_100_u32, 48_000] {
            let start_ms = 1234_u64; let end_ms = 2345_u64;
            let range = LoopRange::from_milliseconds(start_ms, end_ms, sample_rate).unwrap();
            let frame_ms = |frame: u64| frame as f64 * 1000.0 / sample_rate as f64;
            assert!((frame_ms(range.start) - start_ms as f64).abs() <= 1.0);
            assert!((frame_ms(range.end) - end_ms as f64).abs() <= 1.0);
        }
    }
}
```

- [ ] **Step 2: Run the tests and verify missing loop types fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml audio::loop_cursor::tests`  
Expected: FAIL because `LoopCursor` and `LoopRange` are undefined.

- [ ] **Step 3: Implement end-exclusive frame looping**

Complete `src-tauri/src/audio/loop_cursor.rs`:

```rust
use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoopRange { pub start: u64, pub end: u64 }
impl LoopRange {
    pub fn new(start: u64, end: u64) -> Result<Self, AppError> {
        if end <= start { return Err(AppError::Audio("Loop end must be later than start".into())); }
        Ok(Self { start, end })
    }
    pub fn from_milliseconds(start_ms: u64, end_ms: u64, sample_rate: u32) -> Result<Self, AppError> {
        let frame = |ms: u64| ((ms as u128 * sample_rate as u128 + 500) / 1000) as u64;
        Self::new(frame(start_ms), frame(end_ms))
    }
}

pub struct LoopCursor { position: u64, range: Option<LoopRange> }
impl LoopCursor {
    pub fn new(position: u64, range: Option<LoopRange>) -> Self { Self { position, range } }
    pub fn set_position(&mut self, position: u64) { self.position = position; }
    pub fn set_range(&mut self, range: Option<LoopRange>) { self.range = range; }
    pub fn take(&mut self) -> u64 {
        if let Some(range) = self.range { if self.position >= range.end { self.position = range.start; } }
        let current = self.position;
        self.position += 1;
        current
    }
}
```

- [ ] **Step 4: Write a failing real-time render-core test**

Create `src-tauri/src/audio/render.rs` with this test:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drops_stale_generations_and_reports_the_source_position() {
        let (mut producer, consumer) = rtrb::RingBuffer::new(8);
        producer.push(QueuedFrame { generation: 1, source_frame: 10, left: .1, right: .2 }).unwrap();
        producer.push(QueuedFrame { generation: 2, source_frame: 20, left: .3, right: .4 }).unwrap();
        let state = Arc::new(RenderState::new()); state.generation.store(2, Ordering::Release); state.playing.store(true, Ordering::Release);
        let mut render = RenderCore::new(consumer, state.clone());
        let mut output = [0.0_f32; 2]; render.fill_f32(&mut output, 2);
        assert_eq!(output, [.3, .4]);
        assert_eq!(state.source_frame.load(Ordering::Acquire), 20);
    }

    #[test]
    fn pause_outputs_silence_without_consuming_queued_audio() {
        let (mut producer, consumer) = rtrb::RingBuffer::new(4);
        producer.push(QueuedFrame { generation: 0, source_frame: 8, left: .5, right: .5 }).unwrap();
        let state = Arc::new(RenderState::new());
        let mut render = RenderCore::new(consumer, state.clone());
        let mut output = [1.0_f32; 2];
        render.fill_f32(&mut output, 2);
        assert_eq!(output, [0.0, 0.0]);
        state.playing.store(true, Ordering::Release);
        render.fill_f32(&mut output, 2);
        assert_eq!(output, [.5, .5]);
    }
}
```

- [ ] **Step 5: Implement the allocation-free callback core**

Complete `src-tauri/src/audio/render.rs`:

```rust
use rtrb::Consumer;
use std::sync::{Arc, atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering}};

#[derive(Debug, Clone, Copy)]
pub struct QueuedFrame { pub generation: u64, pub source_frame: u64, pub left: f32, pub right: f32 }
pub struct RenderState {
    pub generation: AtomicU64, pub source_frame: AtomicU64, pub playing: AtomicBool,
    pub volume_bits: AtomicU32, pub underruns: AtomicU64,
}
impl RenderState { pub fn new() -> Self { Self { generation: AtomicU64::new(0), source_frame: AtomicU64::new(0), playing: AtomicBool::new(false), volume_bits: AtomicU32::new(1.0_f32.to_bits()), underruns: AtomicU64::new(0) } } }

pub struct RenderCore { consumer: Consumer<QueuedFrame>, state: Arc<RenderState> }
impl RenderCore {
    pub fn new(consumer: Consumer<QueuedFrame>, state: Arc<RenderState>) -> Self { Self { consumer, state } }
    pub fn fill_f32(&mut self, output: &mut [f32], output_channels: usize) {
        let generation = self.state.generation.load(Ordering::Acquire);
        let volume = f32::from_bits(self.state.volume_bits.load(Ordering::Relaxed));
        for device_frame in output.chunks_mut(output_channels) {
            if !self.state.playing.load(Ordering::Relaxed) {
                device_frame.fill(0.0);
                continue;
            }
            let mut next = None;
            while let Ok(frame) = self.consumer.pop() { if frame.generation == generation { next = Some(frame); break; } }
            if let Some(frame) = next {
                for (channel, sample) in device_frame.iter_mut().enumerate() { *sample = if channel == 0 { frame.left } else { frame.right } * volume; }
                self.state.source_frame.store(frame.source_frame, Ordering::Release);
            } else {
                device_frame.fill(0.0);
                self.state.underruns.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}
```

Declare `pub mod loop_cursor; pub mod render;` in `audio/mod.rs`.

- [ ] **Step 6: Run the precision tests repeatedly and commit**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml audio::loop_cursor -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml audio::render -- --nocapture
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
git add src-tauri/src/audio
git commit -m "feat: enforce sample-counted loop boundaries"
```

---

### Task 13: Connect the Decoder Worker to CPAL Playback

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/audio/engine.rs`
- Create: `src-tauri/src/audio/worker.rs`
- Modify: `src-tauri/src/audio/mod.rs`
- Modify: `src-tauri/src/model.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/bridge/native.ts`

**Interfaces:**
- Consumes: `AudioDecoder`, `LoopRange`, `QueuedFrame`, and `RenderCore`.
- Produces: `AudioEngine`, `EngineCommand`, `PlaybackSnapshot`, and Tauri commands `audio_open`, `audio_play`, `audio_pause`, `audio_seek`, `audio_set_loop`, `audio_clear_loop`, `audio_set_volume`, `audio_snapshot`, and `audio_close`.

- [ ] **Step 1: Add device-output and command-channel dependencies**

```powershell
Set-Location src-tauri
cargo add cpal@0.17
cargo add crossbeam-channel
Set-Location ..
```

- [ ] **Step 2: Write a failing decoder-worker sequence test with a synthetic source**

Create a `FrameSource` trait in `src-tauri/src/audio/worker.rs` and test it without an audio device:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    struct SyntheticSource { sample_rate: u32, frames: u64, next: u64 }
    impl SyntheticSource { fn ramp(sample_rate: u32, frames: u64) -> Self { Self { sample_rate, frames, next: 0 } } }
    impl FrameSource for SyntheticSource {
        fn sample_rate(&self) -> u32 { self.sample_rate }
        fn channels(&self) -> u16 { 2 }
        fn seek_exact(&mut self, frame: u64) -> Result<(), AppError> { self.next = frame; Ok(()) }
        fn next_stereo(&mut self) -> Result<Option<(u64, f32, f32)>, AppError> {
            if self.next >= self.frames { return Ok(None); }
            let frame = self.next; self.next += 1;
            Ok(Some((frame, frame as f32, frame as f32)))
        }
    }
    #[test]
    fn worker_queues_the_loop_start_before_the_callback_reaches_the_end() {
        let source = SyntheticSource::ramp(48_000, 200);
        let (producer, mut consumer) = rtrb::RingBuffer::new(128);
        let state = Arc::new(RenderState::new()); state.generation.store(1, Ordering::Release);
        fill_generation(source, producer, state, 1, 94, Some(LoopRange::new(48, 96).unwrap()), 5).unwrap();
        let frames = (0..5).map(|_| consumer.pop().unwrap().source_frame).collect::<Vec<_>>();
        assert_eq!(frames, vec![94, 95, 48, 49, 50]);
    }
}
```

- [ ] **Step 3: Run the worker test and verify missing worker functions fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml audio::worker::tests`  
Expected: FAIL because the worker abstractions do not exist.

- [ ] **Step 4: Implement the decoder worker and generation protocol**

Define in `worker.rs`:

```rust
pub enum EngineCommand {
    Play, Pause, Seek(u64), SetLoop(Option<LoopRange>), Shutdown,
}
pub trait FrameSource: Send {
    fn sample_rate(&self) -> u32;
    fn channels(&self) -> u16;
    fn seek_exact(&mut self, frame: u64) -> Result<(), AppError>;
    fn next_stereo(&mut self) -> Result<Option<(u64, f32, f32)>, AppError>;
}
```

Implement `FrameSource` for `AudioDecoder`, downmixing mono by duplication and more than two channels by averaging even-indexed channels into left and odd-indexed channels into right on the worker thread. Keep one decoded `DecodedChunk` plus an offset in the adapter; `next_stereo()` returns the chunk's real `start_frame + offset` and never fabricates frame numbers.

Implement the deterministic test helper with this exact sequence rule:

```rust
pub fn fill_generation<S: FrameSource>(
    mut source: S, mut producer: Producer<QueuedFrame>, state: Arc<RenderState>, generation: u64,
    position: u64, range: Option<LoopRange>, count: usize,
) -> Result<(), AppError> {
    let mut cursor = LoopCursor::new(position, range);
    let mut expected_next = None;
    for _ in 0..count {
        let wanted = cursor.take();
        if expected_next != Some(wanted) { source.seek_exact(wanted)?; }
        let (actual, left, right) = source.next_stereo()?.ok_or_else(|| AppError::Audio("Unexpected end of audio".into()))?;
        if actual != wanted { return Err(AppError::Audio(format!("Decoder returned frame {actual}, expected {wanted}"))); }
        let mut queued = QueuedFrame { generation, source_frame: actual, left, right };
        loop {
            match producer.push(queued) {
                Ok(()) => break,
                Err(rtrb::PushError::Full(value)) => { queued = value; std::thread::yield_now(); }
            }
        }
        expected_next = Some(wanted + 1);
    }
    state.source_frame.store(position, Ordering::Release);
    Ok(())
}
```

The production worker uses the same per-frame invariant but remains in a command/fill loop. It drains all pending commands with `try_recv()` before each fill batch; `Seek` and `SetLoop` increment `RenderState.generation`, reset the cursor, exact-seek the decoder, and then refill. It fills until the one-second ring is at least 250 ms ahead. `Shutdown` exits and acknowledges over a bounded status channel. Errors go to that channel; the callback never logs or sends.

The worker must keep at least 250 ms of frames queued, must reach a loop end only after the exact loop-start frames have been decoded, and must send errors through a bounded status channel rather than logging from the callback.

- [ ] **Step 5: Implement CPAL stream selection and callback conversion**

Create `src-tauri/src/audio/engine.rs` with the model types imported from `model.rs`:

```rust
pub struct AudioEngine {
    command_tx: Option<Sender<EngineCommand>>, status_rx: Option<Receiver<Result<(), AppError>>>,
    render_state: Arc<RenderState>, stream: Option<cpal::Stream>, worker: Option<JoinHandle<()>>,
    sample_rate: u32, duration_ms: u64, loop_range: Option<Selection>, last_error: Option<String>,
}

pub fn ring_capacity_frames(sample_rate: u32) -> usize { sample_rate as usize }
```

`AudioEngine::open(&mut self, path)` probes the source, chooses an output configuration whose supported sample-rate range includes the source sample rate, constructs an rtrb buffer with `ring_capacity_frames(sample_rate)`, spawns the decoder worker, and builds a CPAL stream. Call `stream.play()` once; pause/play state is then an atomic render decision so restarting does not add device latency. Return an actionable `AppError::Audio` if there is no default device or no configuration covering the source rate.

Build separate callbacks for `f32`, `i16`, and `u16`. The `f32` callback passes the device slice directly to `RenderCore::fill_f32()`. The integer builders allocate a scratch `Vec<f32>` of `sample_rate * output_channels` before the callback closure; inside the callback, process the device buffer in chunks no larger than that scratch slice, call `fill_f32()`, and convert with `i16::from_sample()` or `u16::from_sample()`. Thus callback buffer size cannot trigger a resize or allocation.

The public methods send commands and update atomics only:

```rust
pub fn open(&mut self, path: &Path) -> Result<AudioIdentity, AppError>;
pub fn play(&self) -> Result<(), AppError>;
pub fn pause(&self) -> Result<(), AppError>;
pub fn seek_ms(&self, milliseconds: u64) -> Result<(), AppError>;
pub fn set_loop_ms(&self, selection: Option<Selection>) -> Result<(), AppError>;
pub fn set_volume(&self, volume: f32) -> Result<(), AppError>;
pub fn snapshot(&mut self) -> PlaybackSnapshot;
pub fn close(&mut self) -> Result<(), AppError>;
```

`set_loop_ms()` converts through `LoopRange::from_milliseconds()`. `snapshot()` converts the authoritative source-frame atomic back to integer milliseconds.

- [ ] **Step 6: Add managed engine state and Tauri commands**

Add to `model.rs`:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackState { Empty, Paused, Playing, Error(String) }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSnapshot { pub state: PlaybackState, pub position_ms: u64, pub duration_ms: u64, pub loop_range: Option<Selection>, pub volume: f32, pub underruns: u64 }
```

Manage `Mutex<AudioEngine>` in Tauri state. Each audio command acquires the mutex only on the Tauri command thread and immediately calls the corresponding nonblocking engine method. Register all commands and extend `NativeBridge` with matching methods and `PlaybackSnapshot` TypeScript types.

Add the complete frontend bridge surface in `native.ts`:

```ts
export interface PlaybackSnapshot {
  state: 'empty' | 'paused' | 'playing' | { error: string };
  positionMs: number; durationMs: number; loopRange: Selection | null; volume: number; underruns: number;
}

export interface NativeBridge {
  saveProject(project: Project): Promise<void>;
  loadProject(canonicalAudioPath: string): Promise<Project | null>;
  readTsv(path: string, multilinePolicy: MultilinePolicy): Promise<ImportedTsv>;
  writeTsv(path: string, project: Project): Promise<void>;
  inspectAudio(path: string): Promise<AudioIdentity>;
  analyzeAudio(path: string): Promise<PeakData>;
  cancelAnalysis(): Promise<void>;
  onAnalysisProgress(handler: (progress: AnalysisProgress) => void): Promise<() => void>;
  audioOpen(path: string): Promise<AudioIdentity>;
  audioPlay(): Promise<void>;
  audioPause(): Promise<void>;
  audioSeek(milliseconds: number): Promise<void>;
  audioSetLoop(selection: Selection): Promise<void>;
  audioClearLoop(): Promise<void>;
  audioSetVolume(volume: number): Promise<void>;
  audioSnapshot(): Promise<PlaybackSnapshot>;
  audioClose(): Promise<void>;
}
```

Add the corresponding `invoke()` entries to `tauriBridge`. Validate finite volume in `0..=1`, clamp seeks to duration, and reject loops outside the clip before sending worker commands.

- [ ] **Step 7: Verify real-time rules, precision, and compilation**

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml audio
bun run check
```

Inspect the CPAL callback closure and confirm it contains no `Vec::new`, `format!`, file access, decoder call, channel send, mutex lock, or logging call. Expected: all tests and checks pass.

- [ ] **Step 8: Commit native playback**

```powershell
git add src-tauri src/lib/bridge/native.ts
git commit -m "feat: add precise native audio playback"
```

---

### Task 14: Integrate File Opening, Playback Controls, Shortcuts, Timeline, and Annotation UI

**Files:**
- Create: `src/lib/state/audioSession.ts`
- Create: `src/lib/state/audioSession.test.ts`
- Create: `src/lib/domain/importTsv.ts`
- Create: `src/lib/domain/importTsv.test.ts`
- Create: `src/lib/components/ClipToolbar.svelte`
- Create: `src/lib/components/ClipToolbar.test.ts`
- Create: `src/lib/components/ErrorBanner.svelte`
- Modify: `src/lib/bridge/native.ts`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`
- Modify: `src/app.css`

**Interfaces:**
- Consumes: Task 11 audio inspection/peaks, Task 13 playback commands, Task 6 project store, Task 9 timeline, and Task 10 waveform adapter.
- Produces: the complete open → select → loop → annotate → reopen → export application flow and global playback shortcuts.

- [ ] **Step 1: Add typed file pickers to the native bridge**

Use `@tauri-apps/plugin-dialog` in `native.ts`:

```ts
import { open, save } from '@tauri-apps/plugin-dialog';

export async function pickAudioPath(): Promise<string | null> {
  const value = await open({ multiple: false, filters: [{ name: 'Audio', extensions: ['mp3', 'wav'] }] });
  return typeof value === 'string' ? value : null;
}
export async function pickTsvPath(): Promise<string | null> {
  const value = await open({ multiple: false, filters: [{ name: 'TSV worksheet', extensions: ['tsv'] }] });
  return typeof value === 'string' ? value : null;
}
export async function chooseTsvExportPath(defaultPath?: string): Promise<string | null> {
  return save({ defaultPath, filters: [{ name: 'TSV worksheet', extensions: ['tsv'] }] });
}
```

Register `tauri_plugin_dialog::init()` in `lib.rs`, and set `src-tauri/capabilities/default.json` permissions to include `"core:default"`, `"dialog:allow-open"`, and `"dialog:allow-save"`. No directory enumeration command is exposed; each workflow receives only the single path explicitly selected by the user.

- [ ] **Step 2: Write failing audio-session shortcut and polling tests**

Create `src/lib/state/audioSession.test.ts`:

```ts
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioSession } from './audioSession';

describe('AudioSession', () => {
  const bridge = {
    audioPlay: vi.fn(async () => undefined), audioPause: vi.fn(async () => undefined),
    audioSeek: vi.fn(async () => undefined), audioSetLoop: vi.fn(async () => undefined),
    audioClearLoop: vi.fn(async () => undefined), audioSetVolume: vi.fn(async () => undefined), audioClose: vi.fn(async () => undefined),
    audioSnapshot: vi.fn(async () => ({ state: 'paused', positionMs: 123, durationMs: 1000, loopRange: null, volume: 1, underruns: 0 }))
  };
  beforeEach(() => vi.clearAllMocks());

  it('polls the authoritative native position', async () => {
    const session = new AudioSession(bridge); await session.refresh();
    expect(get(session).positionMs).toBe(123);
  });

  it('sets and clears native loops', async () => {
    const session = new AudioSession(bridge);
    await session.setLoop({ startMs: 10, endMs: 20 });
    await session.setLoop(null);
    expect(bridge.audioSetLoop).toHaveBeenCalledWith({ startMs: 10, endMs: 20 });
    expect(bridge.audioClearLoop).toHaveBeenCalled();
  });

  it('forwards volume and closes polling with the native stream', async () => {
    const session = new AudioSession(bridge);
    session.startPolling();
    await session.setVolume(0.4);
    await session.close();
    expect(bridge.audioSetVolume).toHaveBeenCalledWith(0.4);
    expect(bridge.audioClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the session test and verify the missing class fails**

Run: `bun test src/lib/state/audioSession.test.ts`  
Expected: FAIL because `AudioSession` does not exist.

- [ ] **Step 4: Implement the native audio session store**

Create `src/lib/state/audioSession.ts`:

```ts
import { writable, type Readable } from 'svelte/store';
import type { Selection } from '../domain/types';

export interface PlaybackSnapshot { state: 'empty' | 'paused' | 'playing' | { error: string }; positionMs: number; durationMs: number; loopRange: Selection | null; volume: number; underruns: number }
interface AudioBridge {
  audioPlay(): Promise<void>; audioPause(): Promise<void>; audioSeek(milliseconds: number): Promise<void>;
  audioSetLoop(selection: Selection): Promise<void>; audioClearLoop(): Promise<void>;
  audioSetVolume(volume: number): Promise<void>; audioClose(): Promise<void>;
  audioSnapshot(): Promise<PlaybackSnapshot>;
}

const empty: PlaybackSnapshot = { state: 'empty', positionMs: 0, durationMs: 0, loopRange: null, volume: 1, underruns: 0 };
export class AudioSession implements Readable<PlaybackSnapshot> {
  private readonly state = writable(empty); private timer: ReturnType<typeof setInterval> | null = null;
  readonly subscribe = this.state.subscribe;
  constructor(private readonly bridge: AudioBridge) {}
  startPolling(): void { if (!this.timer) this.timer = setInterval(() => void this.refresh(), 33); }
  stopPolling(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async refresh(): Promise<void> {
    try { this.state.set(await this.bridge.audioSnapshot()); }
    catch (error) { this.state.update((value) => ({ ...value, state: { error: error instanceof Error ? error.message : String(error) } })); }
  }
  async play(): Promise<void> { await this.bridge.audioPlay(); await this.refresh(); }
  async pause(): Promise<void> { await this.bridge.audioPause(); await this.refresh(); }
  async seek(milliseconds: number): Promise<void> { await this.bridge.audioSeek(milliseconds); await this.refresh(); }
  async setLoop(selection: Selection | null): Promise<void> { if (selection) await this.bridge.audioSetLoop(selection); else await this.bridge.audioClearLoop(); await this.refresh(); }
  async setVolume(volume: number): Promise<void> { await this.bridge.audioSetVolume(volume); await this.refresh(); }
  async close(): Promise<void> { this.stopPolling(); await this.bridge.audioClose(); this.state.set(empty); }
}
```

- [ ] **Step 5: Merge imported TSV labels and annotations through stable IDs**

Create `src/lib/domain/importTsv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createProject } from './project';
import { mergeImportedTsv } from './importTsv';

it('discovers speaker and tag labels while preserving overlapping rows', () => {
  const project = createProject({ canonicalPath: 'a.wav', size: 1, modifiedMs: 1, durationMs: 1000, sampleRate: 1000, channels: 1 });
  let serial = 0;
  const merged = mergeImportedTsv(project, {
    speakers: ['guest'], acousticTags: ['laugh'],
    annotations: [
      { startMs: 10, endMs: 30, eventType: 'speech', transcription: 'one', intelligibility: 'intelligible', speaker: 'guest', overlap: 'overlap', confidence: 'high', acousticTags: ['laugh'], notes: '' },
      { startMs: 20, endMs: 40, eventType: 'speech', transcription: 'two', intelligibility: 'intelligible', speaker: 'guest', overlap: 'overlap', confidence: 'high', acousticTags: [], notes: '' }
    ]
  }, () => `import-${++serial}`, '2026-01-01T00:00:00Z');
  expect(merged.annotations).toHaveLength(2);
  expect(merged.annotations[0].speakerId).toBe(merged.speakers.find((item) => item.label === 'guest')!.id);
  expect(merged.annotations[0].acousticTagIds).toEqual([merged.acousticTags.find((item) => item.label === 'laugh')!.id]);
});
```

Create `src/lib/domain/importTsv.ts`:

```ts
import type { ImportedTsv } from '../bridge/native';
import type { LabelDefinition, Project } from './types';

function includeLabels(items: LabelDefinition[], labels: string[], id: () => string): LabelDefinition[] {
  const result = [...items];
  for (const raw of labels) {
    const label = raw.trim();
    if (!label || label === 'none' || result.some((item) => item.label === label)) continue;
    result.push({ id: id(), label });
  }
  return result;
}

export function mergeImportedTsv(
  project: Project, imported: ImportedTsv, id = () => crypto.randomUUID(), now = new Date().toISOString()
): Project {
  for (const item of imported.annotations) {
    if (!Number.isInteger(item.startMs) || !Number.isInteger(item.endMs) || item.startMs < 0 || item.endMs <= item.startMs || item.endMs > project.audioIdentity.durationMs) {
      throw new Error('Imported annotation boundaries must be integer milliseconds inside the current clip');
    }
    if (item.eventType === 'speech' && (!item.speaker || item.speaker === 'none')) throw new Error('Imported speech annotations require a speaker');
    if ((item.intelligibility === 'intelligible' || item.intelligibility === 'partially_intelligible') && !item.transcription.trim()) {
      throw new Error('Imported intelligible speech requires transcription');
    }
  }
  const speakers = includeLabels(project.speakers, imported.speakers, id);
  const acousticTags = includeLabels(project.acousticTags, imported.acousticTags, id);
  const speakerId = (label: string | null) => label && label !== 'none' ? speakers.find((item) => item.label === label)?.id ?? null : null;
  const tagIds = (labels: string[]) => labels.flatMap((label) => {
    const match = acousticTags.find((item) => item.label === label);
    return match ? [match.id] : [];
  });
  const annotations = imported.annotations.map((item) => ({
    id: id(), startMs: item.startMs, endMs: item.endMs, eventType: item.eventType,
    transcription: item.transcription, intelligibility: item.intelligibility,
    speakerId: speakerId(item.speaker), overlap: item.overlap, confidence: item.confidence,
    acousticTagIds: tagIds(item.acousticTags), notes: item.notes, createdAt: now, updatedAt: now
  }));
  return {
    ...project, speakers, acousticTags,
    annotations: [...project.annotations, ...annotations].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
  };
}
```

Run: `bun test src/lib/domain/importTsv.test.ts`  
Expected: PASS after implementing the merger. TSV header aliasing (`japanese` to `transcription`) remains in the native parser from Task 5; this layer only maps portable labels to stable project IDs.

- [ ] **Step 6: Write a failing toolbar interaction test**

Create `src/lib/components/ClipToolbar.test.ts`:

```ts
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ClipToolbar from './ClipToolbar.svelte';

describe('ClipToolbar', () => {
  it('exposes playback, looping, import, display format, and export actions', async () => {
    const actions = { open: vi.fn(), importTsv: vi.fn(), togglePlay: vi.fn(), toggleLoop: vi.fn(), toggleFormat: vi.fn(), exportTsv: vi.fn(), cancelAnalysis: vi.fn() };
    render(ClipToolbar, { filename: 'clip.wav', playing: false, loopEnabled: true, format: 'seconds', analysisPercent: null, actions });
    await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Import TSV' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Export TSV' }));
    expect(actions.togglePlay).toHaveBeenCalled();
    expect(actions.importTsv).toHaveBeenCalled();
    expect(actions.exportTsv).toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Implement toolbar and persistent error banner**

Create `src/lib/components/ClipToolbar.svelte`:

```svelte
<script lang="ts">
  import type { TimeDisplayFormat } from '../domain/types';
  export let filename: string | null; export let playing: boolean; export let loopEnabled: boolean; export let format: TimeDisplayFormat;
  export let volume = 1; export let analysisPercent: number | null = null;
  export let actions: { open(): void; importTsv(): void; togglePlay(): void; toggleLoop(): void; toggleFormat(): void; exportTsv(): void; cancelAnalysis(): void; setVolume?(value: number): void };
</script>
<header class="clip-toolbar">
  <button type="button" on:click={actions.open}>Open audio</button>
  <span class="filename">{filename ?? 'No clip open'}</span>
  <button type="button" disabled={!filename} on:click={actions.togglePlay}>{playing ? 'Pause' : 'Play'}</button>
  <button type="button" class:active={loopEnabled} disabled={!filename} on:click={actions.toggleLoop}>Loop</button>
  <label>Volume<input aria-label="Volume" type="range" min="0" max="1" step="0.01" value={volume} on:input={(e) => actions.setVolume?.(+(e.currentTarget as HTMLInputElement).value)} /></label>
  <button type="button" on:click={actions.toggleFormat}>{format === 'seconds' ? 'Show mm:ss.mmm' : 'Show seconds.mmm'}</button>
  <button type="button" disabled={!filename} on:click={actions.importTsv}>Import TSV</button>
  <button type="button" disabled={!filename} on:click={actions.exportTsv}>Export TSV</button>
  {#if analysisPercent !== null}<span>Analyzing waveform {analysisPercent}%</span><button type="button" on:click={actions.cancelAnalysis}>Cancel analysis</button>{/if}
</header>
```

Create `src/lib/components/ErrorBanner.svelte`:

```svelte
<script lang="ts">export let message: string | null; export let dismiss: () => void;</script>
{#if message}<div class="error-banner" role="alert"><span>{message}</span><button type="button" on:click={dismiss}>Dismiss</button></div>{/if}
```

- [ ] **Step 8: Compose the complete app and implement file/project workflow**

Refactor `App.svelte` so its script owns `ProjectStore`, `AudioSession`, `PeakData | null`, `AnalysisProgress | null`, a polite status string, and a persistent error string. It accepts an optional `bridge` prop defaulting to `tauriBridge` and an optional picker set defaulting to the three dialog helpers. Register `bridge.onAnalysisProgress()` on mount and dispose its unlisten function on destroy. Implement the workflows with this ordering so failure preserves the currently open project and waveform:

```ts
import { get } from 'svelte/store';
import { mergeImportedTsv } from './lib/domain/importTsv';

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return 'The operation failed';
}

async function openAudio(): Promise<void> {
  try {
    const path = await pickers.audio();
    if (!path) return;
    const identity = await bridge.inspectAudio(path);
    const restored = await bridge.loadProject(identity.canonicalPath);
    if (restored && (restored.audioIdentity.size !== identity.size || restored.audioIdentity.modifiedMs !== identity.modifiedMs)
      && !confirm('The source audio changed. Reuse its existing annotations and regenerate the waveform?')) return;
    const nextProject = restored ? { ...restored, audioIdentity: identity } : createProject(identity);
    analysisProgress = { processedMs: 0, durationMs: identity.durationMs };
    const nextPeaks = await bridge.analyzeAudio(path);
    await bridge.audioOpen(path);
    projectStore.open(nextProject);
    peaks = nextPeaks;
    audioSession.startPolling();
    status = `Opened ${path.split(/[\\/]/).at(-1)}`;
  } catch (error) {
    persistentError = errorText(error);
  } finally {
    analysisProgress = null;
  }
}

async function importTsv(): Promise<void> {
  try {
    const project = get(projectStore).project;
    if (!project) return;
    const path = await pickers.tsv();
    if (!path) return;
    const imported = await bridge.readTsv(path, project.exportSettings.multilinePolicy);
    if (!await projectStore.mutateProject((value) => mergeImportedTsv(value, imported))) return;
    status = `Imported ${imported.annotations.length} annotations`;
  } catch (error) {
    persistentError = errorText(error);
  }
}

async function exportTsv(): Promise<void> {
  try {
    const project = get(projectStore).project;
    if (!project) return;
    const path = await pickers.exportTsv();
    if (!path) return;
    await bridge.writeTsv(path, project);
    status = `Exported ${project.annotations.length} annotation${project.annotations.length === 1 ? '' : 's'}`;
  } catch (error) {
    persistentError = errorText(error);
  }
}
```

Render in order: `ErrorBanner`, `ClipToolbar`, `<div role="status" aria-live="polite">`, `TimelineWorkspace` (which owns `WaveformView`), `AnnotationDashboard` with speaker/tag managers, and `AnnotationTable`. Pass `projectStore.selectAnnotation` and `projectStore.removeAnnotation` to the table. Map each annotation's `speakerId` to its current label for table display. Persist time-format changes through `mutateProject()`. The toolbar's cancel action calls `bridge.cancelAnalysis()`, and its percent is `Math.round(processedMs / durationMs * 100)`. Its volume action calls `audioSession.setVolume()`.

For the production Tauri bridge, register `getCurrentWindow().onCloseRequested()` from `@tauri-apps/api/window`. Prevent the first close event, await `projectStore.flush()` and `audioSession.close()`, dispose the analysis listener, then call `getCurrentWindow().destroy()`. Unit tests use an injected no-op lifecycle adapter, so they do not import a live Tauri window. This closes the 300 ms debounce window and makes the current draft recoverable even after an immediate close.

In Task 13, construct the replacement CPAL stream and worker into local variables and swap them into `AudioEngine` only after all construction succeeds; this is what makes the UI ordering above preserve a playing clip if a new audio open fails.

Use `src/app.css` to establish a compact desktop layout rather than a responsive marketing page:

```css
:root { font: 14px/1.4 system-ui, sans-serif; color: #e8edf5; background: #111722; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 900px; min-height: 100vh; background: #111722; }
button, input, select, textarea { font: inherit; }
button { color: inherit; background: #263246; border: 1px solid #465771; border-radius: 4px; padding: .4rem .65rem; }
button:disabled { opacity: .45; }
.clip-toolbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: .6rem; padding: .7rem; background: #182131; border-bottom: 1px solid #344258; }
.filename { min-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.timeline-viewport { overflow-x: auto; margin: .75rem; background: #0d131d; border: 1px solid #344258; }
.timeline-content { position: relative; min-width: 100%; }
.time-ruler { position: relative; height: 26px; color: #aebbd0; border-block: 1px solid #344258; }
.tick { position: absolute; transform: translateX(-1px); border-left: 1px solid #566882; padding-left: 3px; white-space: nowrap; }
.selection-track { position: relative; height: 22px; background: #151f2f; }
.selection { position: absolute; inset-block: 2px; display: grid; grid-template-columns: 8px 1fr 8px; background: rgba(90, 154, 255, .42); }
.selection button { min-width: 0; padding: 0; border: 0; background: transparent; }
.waveform, .waveform-slot { height: 190px; }
.annotation-dashboard { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; margin: .75rem; padding: .8rem; background: #182131; }
.annotation-dashboard textarea, .annotation-dashboard fieldset, .annotation-dashboard .actions { grid-column: 1 / -1; }
.annotation-dashboard label { display: grid; gap: .25rem; }
.annotation-dashboard input, .annotation-dashboard select, .annotation-dashboard textarea { color: #eef3fb; background: #0f1622; border: 1px solid #465771; padding: .4rem; }
.annotation-table { margin: .75rem; display: grid; gap: .35rem; }
.annotation-row { display: grid; grid-template-columns: 1fr auto; gap: .35rem; }
.annotation-row > button:first-child { display: grid; grid-template-columns: 12rem 10rem 1fr; text-align: left; }
.annotation-row.active { outline: 2px solid #69a5ff; }
.error-banner { margin: .75rem; padding: .65rem; display: flex; justify-content: space-between; color: #ffd7d7; background: #541f2a; }
```

- [ ] **Step 9: Implement global playback shortcuts with text-field and IME guards**

Add a window keydown handler in `App.svelte` and remove it on destroy:

```ts
function globalKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (event.isComposing || target?.matches('input, textarea, select, [contenteditable="true"]')) return;
  const project = get(projectStore).project; if (!project) return;
  if (event.code === 'Space') { event.preventDefault(); void (get(audioSession).state === 'playing' ? audioSession.pause() : audioSession.play()); }
  else if (event.key.toLowerCase() === 'i') {
    const startMs = Math.min(get(audioSession).positionMs, project.audioIdentity.durationMs - 1);
    projectStore.setSelection({ startMs, endMs: Math.min(project.audioIdentity.durationMs, Math.max(startMs + 1, project.activeSelection?.endMs ?? startMs + 1)) });
  }
  else if (event.key.toLowerCase() === 'o' && project.activeSelection && get(audioSession).positionMs > project.activeSelection.startMs) projectStore.setSelection({ ...project.activeSelection, endMs: get(audioSession).positionMs });
  else if (event.key.toLowerCase() === 'l') void audioSession.setLoop(get(audioSession).loopRange ? null : project.activeSelection);
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const delta = (event.shiftKey ? 1000 : 50) * (event.key === 'ArrowLeft' ? -1 : 1); void audioSession.seek(Math.min(project.audioIdentity.durationMs, Math.max(0, get(audioSession).positionMs + delta))); }
}
```

Whenever the canonical selection changes and looping is enabled, send the new selection to `AudioSession.setLoop()`.

- [ ] **Step 10: Add an application integration test with a fake native bridge**

Update `App.svelte` to accept an optional `bridge` prop defaulting to `tauriBridge`, and make file-picker functions injectable through a second `pickers` prop. Extend `src/App.test.ts` with:

```ts
it('opens a mock clip, shows the timeline, commits an annotation, and exports', async () => {
  const projectSaves: unknown[] = [];
  const bridge = makeFakeBridge({ onSave: (value) => projectSaves.push(value) });
  render(App, { bridge, pickers: { audio: async () => 'clip.wav', tsv: async () => null, exportTsv: async () => 'clip.tsv' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
  expect(await screen.findByLabelText('Audio waveform')).toBeInTheDocument();
  await fireEvent.input(screen.getByLabelText('Start milliseconds'), { target: { value: '100' } });
  await fireEvent.input(screen.getByLabelText('End milliseconds'), { target: { value: '250' } });
  await fireEvent.input(screen.getByLabelText('Transcription'), { target: { value: 'うん' } });
  await fireEvent.keyDown(screen.getByLabelText('Transcription'), { key: 'Enter' });
  expect(screen.getByLabelText('Saved annotations')).toHaveTextContent('うん');
  await fireEvent.click(screen.getByRole('button', { name: 'Export TSV' }));
  expect(bridge.writeTsv).toHaveBeenCalledWith('clip.tsv', expect.objectContaining({ annotations: [expect.objectContaining({ transcription: 'うん' })] }));
});
```

`makeFakeBridge()` returns fixed identity, peaks, and paused playback snapshots and uses Vitest spies for every method. It must live in `src/test/fakeBridge.ts`, not in production code.

- [ ] **Step 11: Run full frontend verification and commit**

```powershell
bun test
bun run check
bun run build
git add src
git commit -m "feat: integrate Lightscribe transcription workflow"
```

---

### Task 15: Verify Recovery, Import, Performance, Packaging, and the Complete Desktop Story

**Files:**
- Create: `tests/fixtures/annotation-audio-test.wav`
- Create: `tests/fixtures/pass-a.annotation.private.tsv`
- Create: `tests/e2e/lightscribe.spec.ts`
- Create: `src-tauri/examples/generate_fixture.rs`
- Create: `src-tauri/tests/native_integration.rs`
- Create: `src/test/browserFakeBridge.ts`
- Create: `playwright.config.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: the complete application from Tasks 1–14.
- Produces: repeatable full-flow browser verification with a fake native boundary, native Rust integration coverage, a Windows desktop bundle, and operator-facing development instructions.

- [ ] **Step 1: Add Playwright and deterministic test fixtures**

```powershell
bun add --dev @playwright/test
bunx playwright install chromium
```

Create `src-tauri/examples/generate_fixture.rs`:

```rust
fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("tests/fixtures/annotation-audio-test.wav");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let spec = hound::WavSpec { channels: 1, sample_rate: 48_000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    for frame in 0..480_000_u64 {
        let sample = if frame == 48_000 || frame == 96_000 { i16::MAX } else { ((frame as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 2_000.0) as i16 };
        writer.write_sample(sample).unwrap();
    }
    writer.finalize().unwrap();
}
```

Run `cargo run --manifest-path src-tauri/Cargo.toml --example generate_fixture` once. Create `tests/fixtures/pass-a.annotation.private.tsv` with these literal UTF-8 rows (tabs between fields):

```tsv
start_seconds	end_seconds	event_type	transcription	intelligibility	speaker	overlap	confidence	acoustic_tags	notes
1.000	2.000	speech	待って	intelligible	speaker_1	overlap	high	quiet_dialogue	
1.500	2.500	speech	はい	intelligible	speaker_2	overlap	medium	breath	
```

Add scripts to `package.json`:

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "verify": "bun test && bun run check && bun run build && cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml"
  }
}
```

- [ ] **Step 2: Configure a development-only fake bridge entrypoint**

Create `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: { command: 'bun run build:test && bun run preview -- --host 127.0.0.1', port: 4173, reuseExistingServer: false }
});
```

Add `"build:test": "vite build --mode test"` to the package scripts. In `main.ts`, use the build-time mode to inject the browser fake only into that build:

```ts
import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const props = import.meta.env.MODE === 'test'
  ? (await import('./test/browserFakeBridge')).browserTestProps()
  : {};
mount(App, { target: document.getElementById('app')!, props });
```

`browserTestProps()` returns a complete fake `NativeBridge` plus pickers. The audio picker reads the `fixture` query parameter as a logical path, the TSV picker returns `pass-a.annotation.private.tsv`, `readTsv()` returns its two parsed rows, and `writeTsv()` stores the last exported UTF-8 text in memory for assertions. Vite replaces the mode comparison at build time, so the dynamic test module is absent from the production graph.

Implement `src/test/browserFakeBridge.ts` with a fixed identity/peaks/snapshot and these deterministic data methods:

```ts
import type { NativeBridge, PlaybackSnapshot } from '../lib/bridge/native';
import type { Project } from '../lib/domain/types';

const identity = { canonicalPath: 'annotation-audio-test.wav', size: 960_044, modifiedMs: 1, durationMs: 10_000, sampleRate: 48_000, channels: 1 };
let saved: Project | null = null;
let snapshot: PlaybackSnapshot = { state: 'paused', positionMs: 0, durationMs: 10_000, loopRange: null, volume: 1, underruns: 0 };

function tsv(project: Project): string {
  const header = 'start_seconds\tend_seconds\tevent_type\ttranscription\tintelligibility\tspeaker\toverlap\tconfidence\tacoustic_tags\tnotes\n';
  const speaker = (id: string | null) => project.speakers.find((item) => item.id === id)?.label ?? 'none';
  const tags = (ids: string[]) => ids.map((id) => project.acousticTags.find((item) => item.id === id)?.label).filter((label): label is string => Boolean(label)).join(';');
  const rows = project.annotations.map((item) => [
    (item.startMs / 1000).toFixed(3), (item.endMs / 1000).toFixed(3), item.eventType,
    item.transcription.replaceAll('\\', '\\\\').replaceAll('\n', '\\n'), item.intelligibility, speaker(item.speakerId),
    item.overlap, item.confidence, tags(item.acousticTagIds), item.notes.replaceAll('\\', '\\\\').replaceAll('\n', '\\n')
  ].join('\t')).join('\n');
  return header + rows + (rows ? '\n' : '');
}

export function browserTestProps() {
  const bridge: NativeBridge = {
    saveProject: async (project) => { saved = structuredClone(project); },
    loadProject: async () => saved,
    readTsv: async () => ({
      speakers: ['speaker_1', 'speaker_2'], acousticTags: ['quiet_dialogue', 'breath'],
      annotations: [
        { startMs: 1000, endMs: 2000, eventType: 'speech', transcription: '待って', intelligibility: 'intelligible', speaker: 'speaker_1', overlap: 'overlap', confidence: 'high', acousticTags: ['quiet_dialogue'], notes: '' },
        { startMs: 1500, endMs: 2500, eventType: 'speech', transcription: 'はい', intelligibility: 'intelligible', speaker: 'speaker_2', overlap: 'overlap', confidence: 'medium', acousticTags: ['breath'], notes: '' }
      ]
    }),
    writeTsv: async (_path, project) => { (globalThis as typeof globalThis & { __LIGHTSCRIBE_LAST_TSV__: string }).__LIGHTSCRIBE_LAST_TSV__ = tsv(project); },
    inspectAudio: async () => identity,
    analyzeAudio: async () => ({ durationMs: 10_000, sampleRate: 48_000, framesPerPeak: 480, channels: [[-0.1, 0.1, -0.2, 0.2]] }),
    cancelAnalysis: async () => undefined,
    onAnalysisProgress: async () => () => undefined,
    audioOpen: async () => identity,
    audioPlay: async () => { snapshot = { ...snapshot, state: 'playing' }; },
    audioPause: async () => { snapshot = { ...snapshot, state: 'paused' }; },
    audioSeek: async (milliseconds) => { snapshot = { ...snapshot, positionMs: milliseconds }; },
    audioSetLoop: async (selection) => { snapshot = { ...snapshot, loopRange: selection }; },
    audioClearLoop: async () => { snapshot = { ...snapshot, loopRange: null }; },
    audioSetVolume: async (volume) => { snapshot = { ...snapshot, volume }; },
    audioSnapshot: async () => snapshot,
    audioClose: async () => { snapshot = { ...snapshot, state: 'empty', positionMs: 0 }; }
  };
  return {
    bridge,
    pickers: {
      audio: async () => new URLSearchParams(location.search).get('fixture'),
      tsv: async () => 'pass-a.annotation.private.tsv',
      exportTsv: async () => 'lightscribe-export.tsv'
    }
  };
}
```

- [ ] **Step 3: Write the failing end-to-end annotation test**

Create `tests/e2e/lightscribe.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('annotates overlapping regions and preserves renamed labels through export', async ({ page }) => {
  await page.goto('/?fixture=annotation-audio-test.wav');
  await page.getByRole('button', { name: 'Open audio' }).click();
  await expect(page.getByLabel('Audio waveform')).toBeVisible();
  await page.getByRole('button', { name: 'Import TSV' }).click();
  await expect(page.getByLabel('Saved annotations')).toContainText('待って');
  await page.getByLabel('Start milliseconds').fill('3000');
  await page.getByLabel('End milliseconds').fill('4000');
  await page.getByLabel('Transcription').fill('もう一度');
  await page.getByLabel('Transcription').press('Enter');
  await page.getByLabel('Rename speaker_1').fill('narrator');
  await page.getByLabel('Rename speaker_1').blur();
  await page.getByLabel('Rename quiet_dialogue').fill('whisper');
  await page.getByLabel('Rename quiet_dialogue').blur();
  await page.getByRole('button', { name: 'Export TSV' }).click();
  await expect(page.getByRole('status')).toContainText('Exported 3 annotations');
  const exported = await page.evaluate(() => (globalThis as typeof globalThis & { __LIGHTSCRIBE_LAST_TSV__: string }).__LIGHTSCRIBE_LAST_TSV__);
  expect(exported).toContain('\tnarrator\t');
  expect(exported).toContain('whisper');
});
```

- [ ] **Step 4: Run the end-to-end test and implement only the missing status/accessibility hooks**

Run: `bun run test:e2e`  
Expected initially: FAIL at any missing mock-open or export-status hook. Add an `aria-live="polite" role="status"` message after successful export and ensure the browser fake bridge records the UTF-8 TSV string. Rerun until PASS.

- [ ] **Step 5: Add native precision, cache, and 30-minute bounded-memory integration tests**

Create `src-tauri/tests/native_integration.rs` using only public production APIs:

```rust
use lightscribe_lib::audio::{
    decoder::AudioDecoder,
    engine::ring_capacity_frames,
    loop_cursor::{LoopCursor, LoopRange},
    peaks::{analyze_path, cache_path},
};
use std::{fs::OpenOptions, io::Write, path::Path, sync::atomic::AtomicBool};

fn fixture(name: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("tests/fixtures").join(name)
}

#[test]
fn wav_loop_emits_exact_impulse_boundaries() {
    let mut decoder = AudioDecoder::open(&fixture("annotation-audio-test.wav")).unwrap();
    let decoded = decoder.decode_range(47_990, 96_010).unwrap();
    let channels = decoded.channels as usize;
    let at = |frame: u64| decoded.interleaved[((frame - decoded.start_frame) as usize) * channels];
    assert!(at(48_000) > 0.9);
    assert!(at(96_000) > 0.9);
    let mut cursor = LoopCursor::new(95_998, Some(LoopRange::new(48_000, 96_000).unwrap()));
    assert_eq!((0..4).map(|_| cursor.take()).collect::<Vec<_>>(), vec![95_998, 95_999, 48_000, 48_001]);
}

#[test]
fn mp3_exact_seek_matches_sequential_decode() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/decoder-smoke.mp3");
    let mut baseline = AudioDecoder::open(&path).unwrap();
    let from_zero = baseline.decode_range(0, 4_096).unwrap();
    let channels = from_zero.channels as usize;
    let expected = &from_zero.interleaved[3_000 * channels..3_256 * channels];
    let mut sought = AudioDecoder::open(&path).unwrap();
    let actual = sought.decode_range(3_000, 3_256).unwrap();
    assert!(actual.interleaved.iter().zip(expected).all(|(left, right)| (left - right).abs() < 1e-6));
}

#[test]
fn peak_cache_invalidates_after_size_change() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("fixture.wav");
    std::fs::copy(fixture("annotation-audio-test.wav"), &source).unwrap();
    let first = AudioDecoder::open(&source).unwrap().identity().clone();
    let first_key = cache_path(dir.path(), &first);
    OpenOptions::new().append(true).open(&source).unwrap().write_all(&[0]).unwrap();
    let second = AudioDecoder::open(&source).unwrap().identity().clone();
    assert_ne!(first_key, cache_path(dir.path(), &second));
}

#[test]
fn thirty_minute_analysis_keeps_only_bounded_peak_and_ring_storage() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("thirty-minutes.wav");
    let spec = hound::WavSpec { channels: 1, sample_rate: 1_000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut writer = hound::WavWriter::create(&path, spec).unwrap();
    for _ in 0..1_800_000 { writer.write_sample(0_i16).unwrap(); }
    writer.finalize().unwrap();
    let peaks = analyze_path(&path, &AtomicBool::new(false), |_| {}).unwrap();
    assert!(peaks.channels[0].len() <= 1_800 * 100 * 2 + 2);
    assert!(ring_capacity_frames(peaks.sample_rate) <= peaks.sample_rate as usize);
}
```

Export the `audio` module from `lib.rs` and the named submodules/functions from `audio/mod.rs`; they are architectural APIs used by playback as well as tests. The test bounds peak storage to 100 min/max pairs per second per channel and the PCM ring to one second of source frames.

- [ ] **Step 6: Run the entire verification matrix**

```powershell
bun run verify
bun run test:e2e
```

Expected: all TypeScript, component, browser, Rust, formatting, lint, and build checks pass.

- [ ] **Step 7: Build the packaged Windows application and perform the desktop smoke flow**

Run with GUI permission:

```powershell
bun tauri build
```

Install or launch the generated NSIS bundle from `src-tauri/target/release/bundle/nsis/`. Verify this exact story with the committed WAV/TSV fixtures:

1. Open the WAV and observe top ruler → selection bar → waveform → bottom ruler.
2. Use `Ctrl+wheel` in both directions and confirm the pointer time remains fixed.
3. Create a loop with drag and then with I/O shortcuts; verify the dashboard shows integer milliseconds.
4. Play the loop and confirm the audible wrap has no extra WebView latency; retain the automated source-frame assertions from Tasks 12, 13, and 15 as the precision proof.
5. Add two overlapping events, rename a speaker and tag, close, reopen, and confirm recovery.
6. Use Enter to update and Shift+Enter to insert a newline; confirm Japanese IME Enter does not submit.
7. Export all three multiline policies and reopen each TSV.
8. Confirm no source audio or adjacent JSON file changed.

- [ ] **Step 8: Document development and verification commands**

Create `README.md` with:

```markdown
# Lightscribe

Desktop waveform looping and structured transcription annotation for MP3/WAV clips up to 30 minutes.

## Prerequisites

- Bun
- Rust stable with rustfmt and clippy
- Tauri 2 Windows prerequisites: Microsoft C++ Build Tools and WebView2

## Development

`bun install`, then `bun tauri dev`.

## Verification

- `bun run verify`
- `bun run test:e2e`
- `bun tauri build`

The native CPAL/Symphonia engine is authoritative for playback position and applies loop boundaries in source PCM frames. WaveSurfer renders precomputed peaks only.
```

- [ ] **Step 9: Commit the verified release foundation**

```powershell
git add package.json bun.lock playwright.config.ts tests README.md src src-tauri
git commit -m "test: verify complete Lightscribe desktop workflow"
git status --short
```

Expected: clean working tree.
