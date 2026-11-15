# Roadmap

## Phase 1: Core Part Studio
- [ ] Accounts: sign up, log in, sessions (Workers and D1)
- [ ] Documents: create, rename, delete, list, share (owner, editor and viewer roles, checked on the server)
- [ ] Real-time collaboration: Yjs and Durable Objects, presence, live feature edits
- [ ] Kernel worker: rebuild the model whenever its feature list changes
- [ ] Features: sketch (on planes and faces), extrude, revolve, fillet, chamfer, shell, booleans, linear and circular patterns, mirror, variables and expressions
- [ ] Feature list, timeline, rollback, suppress, reorder
- [ ] Viewport: orbit, pan and zoom, view cube, face and edge selection
- [ ] STL and STEP export; volume, area and mass measurements
- [ ] Tests: kernel tests (feature results), API and permission tests, multi-client collaboration tests, Playwright end-to-end tests

## Phase 1b: Offline and local files
- [ ] Installable app (PWA): a service worker caches the app and the WebAssembly kernel so Keel opens offline
- [ ] Local copies of documents in IndexedDB (y-indexeddb); offline edits merge automatically on reconnect
- [ ] Imported files stored locally in OPFS (the browser's private file storage), uploaded to R2 when online
- [ ] `.keel` file format (zip: manifest, editing state, feature list as JSON, attached files) for saving to and opening from disk
- [ ] Local-only documents that never touch the server
- [ ] Ask the browser for persistent storage so offline data isn't evicted

## Phase 2: Documents and history
- [ ] Multiple tabs per document (Part Studios and Assemblies)
- [ ] Versions, history, restoring an earlier version, branching
- [ ] Document usage and activity
- [ ] STEP, IGES and STL import (stored in R2)

## Phase 3: Assemblies
- [ ] Insert parts from Part Studios and other documents
- [ ] Joints: fastened, revolute, slider, cylindrical, planar, ball (WebAssembly constraint solver)
- [ ] Joint limits, driving joints, animation and motion control
- [ ] Interference checks

## Phase 4: Onshape interop
- [ ] "Sign in with Onshape" (OAuth)
- [ ] Import Part Studios and Assemblies (geometry through STEP or Parasolid; rebuild the feature list where possible)
- [ ] Browse the public library

## Phase 5: Simulation (on device)
- [ ] Tetrahedral meshing in WebAssembly
- [ ] Linear static finite-element analysis (stress and displacement) in a Web Worker, sped up with WebGPU
- [ ] Modal analysis

## Phase 6: Input and polish
- [ ] SpaceMouse support through WebHID, with 3Dconnexion's web library as a fallback
- [ ] Onshape- and Fusion-inspired layout: feature list, timeline, ribbon toolbar, right-click marking menu
