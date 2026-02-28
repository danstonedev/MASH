# MASH Export Architecture Audit & World-Class Consolidation Plan

## Executive Summary

The current export surface is functional but fragmented across multiple UI entry points, multiple format modules, and multiple download implementations. This causes duplicated logic, inconsistent schema/timing rules, and avoidable main-thread work for very large sessions.

This plan defines a unified export pipeline that is:

- **Single-source-of-truth** for session/frame retrieval
- **Schema-versioned** per export format
- **Worker-first** for heavy serialization
- **Chunk/stream capable** for very large files
- **UI-agnostic** with one orchestration API used everywhere

## Current Export Surface (Audit)

### UI Entry Points

1. `mash-app/src/components/ui/SessionManager.tsx`
   - Per-session CSV/JSON export button flow
   - Uses direct Dexie reads + local helper download
   - CSV currently workerized, JSON still built on main thread

2. `mash-app/src/components/ui/ExportModal.tsx`
   - Active-session export (CSV/OpenSim/JSON)
   - Uses `opensimExport.ts` directly

3. `mash-app/src/components/layout/panels/ExportPanel.tsx`
   - Playback-loaded session export to C3D/OpenSim/BVH/CSV
   - Uses playback store frames in memory
   - Contains a separate legacy CSV builder

### Export Libraries

1. `mash-app/src/lib/export/buildRecordingCsv.ts`
   - New shared CSV builder used by workerized recording/session export paths

2. `mash-app/src/lib/export/opensimExport.ts`
   - STO + CSV + JSON exporters and a generic `downloadFile`
   - Pulls session/frame data from DB directly

3. `mash-app/src/lib/export/OpenSimExporter.ts`
   - Alternate OpenSim STO implementation (`downloadOpenSimBundle`)
   - Different assumptions and data shaping than `opensimExport.ts`

4. `mash-app/src/lib/export/C3DExporter.ts`
   - C3D writer and direct browser download

5. `mash-app/src/lib/export/BVHExporter.ts`
   - BVH writer and direct browser download

6. `mash-app/src/lib/export/index.ts`
   - Re-exports C3D/BVH/OpenSimExporter APIs (not `opensimExport.ts`)

### Workers

1. `mash-app/src/workers/csvExportWorker.ts`
   - CSV serialization worker (good pattern)

### Data Sources

- `dataManager.exportSessionData(sessionId)` (dynamic local/cloud manager, frames local IndexedDB)
- Direct Dexie reads (`db.imuFrames`, `db.envFrames`) in some UI/lib export paths
- Playback memory (`usePlaybackStore().frames`) in ExportPanel

## Key Problems

1. **Duplicate CSV implementations**
   - `buildRecordingCsv.ts` vs legacy CSV function in `ExportPanel.tsx` vs CSV in `opensimExport.ts`

2. **Two OpenSim paths with diverging logic**
   - `OpenSimExporter.ts` and `opensimExport.ts`

3. **Download logic duplicated**
   - `downloadFile` exists in multiple places
   - C3D/BVH classes also self-download instead of returning payload to orchestrator

4. **Inconsistent timing semantics across formats**
   - Some exports use wall-clock fields, others infer timing from raw timestamps/frame counts

5. **Mixed export data acquisition patterns**
   - Direct DB reads in UI, direct DB reads in export modules, and in-memory playback reads
   - Harder to enforce consistent filtering/mapping/metadata

6. **Large-file risk areas**
   - JSON serialization on main thread in some flows
   - Single huge string build for large CSV/JSON
   - Blob creation done only at end (peak memory spikes)

## Target Architecture (Unified)

## 1) Unified Export Orchestrator

Create `mash-app/src/lib/export/ExportOrchestrator.ts` as the only public API used by UI:

- `prepareExportJob(request): Promise<ExportJobHandle>`
- `runExport(job, onProgress?): Promise<ExportArtifact>`
- `downloadArtifact(artifact): Promise<void>`

Responsibilities:

- Resolve source (sessionId, current playback timeline, explicit frame set)
- Normalize data into canonical in-memory schema
- Route to format plugin
- Prefer worker route automatically
- Expose progress + cancellation

## 2) Canonical Export Data Contract

Create versioned schema in `mash-app/src/lib/export/contracts.ts`:

- `ExportCanonicalSessionV1`
  - session metadata
  - normalized timing model (`systemTimeBase`, `frameTimeMs`, `durationMs`)
  - imu/environment arrays in compact normalized shape
  - sensor mapping + calibration + segment metadata

All format plugins consume this canonical contract, not raw DB entities.

## 3) Format Plugin Layer

Create plugin modules under `mash-app/src/lib/export/formats/`:

- `csv.v1.ts`
- `json.v1.ts`
- `sto.v1.ts`
- `c3d.v1.ts`
- `bvh.v1.ts`

Each plugin should export:

- `id`, `version`, `mimeType`, `fileExtension`
- `estimateSize(canonical): number`
- `serialize(canonical, options, io): Promise<SerializedArtifact>`

## 4) Worker-Oriented Serialization

Create a unified worker entry:

- `mash-app/src/workers/exportWorker.ts`

Capabilities:

- Dispatch plugin serialization by format id
- Return chunks/progress for large jobs
- Support cancellation with job id + abort flag
- Transfer binary buffers where applicable

## 5) Unified Download Sink

Create `mash-app/src/lib/export/download.ts`:

- single helper for `Blob` + filename + mime type
- optional streaming path using `showSaveFilePicker` when available
- fallback to object URL

UI and exporter classes never manage DOM download directly.

## 6) Large-File Strategy (Critical)

For files > ~100MB or very long sessions:

- Use chunked string assembly in worker (e.g., 1–5 MB chunks)
- For CSV/JSON, avoid monolithic concatenation when possible
- For binary formats, write into growable buffers with capped over-allocation
- Use progress callbacks every N rows/chunks
- Support cancel to avoid browser lockups
- Add optional gzip packaging for JSON/CSV (phase 2)

## 7) Deterministic Timing Policy

Create one shared timing utility in `mash-app/src/lib/export/timing.ts`:

- authoritative export timeline from `systemTime` + frame number continuity rules
- consistent duration/rate derivation across CSV/JSON/STO/C3D/BVH
- explicit flags for interpolation/resampling if needed per format

## 8) Observability & Diagnostics

Add structured logs per export job:

- `format`, `source`, `frameCount`, `sensorCount`, estimated size
- timings: `fetch`, `normalize`, `serialize`, `download`
- fallback paths triggered
- worker errors and plugin error category

## 9) Backward Compatibility

- Keep legacy function signatures as wrappers for one release cycle
- Internally route wrappers to orchestrator
- Mark wrappers with TODO + target removal milestone

## Recommended Phased Migration

## Phase A — Foundation (Low Risk, High Leverage)

1. Add canonical contract + timing utility
2. Add unified download sink
3. Add orchestrator shell with CSV/JSON plugins first
4. Route `SessionManager` export buttons to orchestrator

Exit criteria:

- No direct `Blob`/`URL.createObjectURL` in `SessionManager`
- CSV and JSON share same source + timing policy

## Phase B — Format Consolidation

1. Migrate STO/OpenSim to plugin path
2. Deprecate one of the two OpenSim implementations (pick one canonical)
3. Migrate C3D/BVH to return artifacts (no internal download side-effects)
4. Route `ExportPanel` and `ExportModal` through orchestrator

Exit criteria:

- All format exports run through one orchestration flow
- Single OpenSim code path remains

## Phase C — Very Large File Hardening

1. Worker chunk serialization for CSV/JSON
2. Progress + cancel wiring in UI
3. Optional stream-to-disk path (`showSaveFilePicker`) where supported
4. Add stress tests on large synthetic sessions

Exit criteria:

- Export remains responsive for large sessions
- No long main-thread stalls during serialization

## Phase D — Cleanup & Enforcement

1. Remove legacy wrappers and duplicate helpers
2. Add lint rule/grep CI guard to prevent new ad-hoc download helpers
3. Document export extension points for future formats

## Concrete Consolidation Decisions

1. **CSV canonical source**: keep `buildRecordingCsv.ts` as base logic, evolve into `formats/csv.v1.ts`
2. **OpenSim canonical source**: keep `opensimExport.ts` STO math path (already richer metadata), retire duplicate STO generator in `OpenSimExporter.ts` after migration
3. **Data acquisition**: prefer `dataManager` for session exports; playback memory can be an optional source mode but still normalized through canonical contract
4. **UI simplification**: `ExportModal`, `SessionManager`, `ExportPanel` should pass only request parameters (sessionId, format, options) and never serialize directly

## Immediate Next Implementation Slice

Implement now in a single focused slice:

1. Introduce `download.ts` and replace local download helpers in:
   - `SessionManager.tsx`
   - `opensimExport.ts`

2. Introduce `ExportOrchestrator.ts` minimal MVP supporting:
   - format: CSV/JSON
   - source: sessionId
   - worker-first CSV path + JSON path

3. Route `SessionManager` CSV/JSON export buttons through orchestrator

This yields immediate reduction in duplication and creates the spine for C3D/STO/BVH migration.

## Risks & Mitigations

- **Risk:** Export schema drift during migration
  - **Mitigation:** Snapshot tests for representative sessions per format

- **Risk:** Worker serialization memory overhead for giant sessions
  - **Mitigation:** chunked processing + backpressure/progress checkpoints

- **Risk:** User confusion if format outputs change slightly
  - **Mitigation:** explicit export version in metadata headers and release note callouts

## Success Metrics

- One export orchestrator API used by all UI surfaces
- One canonical CSV implementation and one canonical OpenSim implementation
- 0 direct ad-hoc download helpers in UI components
- Main-thread export blocking reduced (tracked via timing logs)
- Stable export behavior for multi-minute, multi-sensor high-rate sessions
