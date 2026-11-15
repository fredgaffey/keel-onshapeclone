# Keel

Keel is a collaborative CAD app that runs in the browser. Modelling, assembly solving and simulation all run on your own device as WebAssembly, and Keel is hosted on Cloudflare.

> Keel is an independent project. It is not affiliated with or endorsed by PTC or Onshape®, or by Autodesk or Fusion 360®. Those names belong to their owners.

## Status

Early development. See [ROADMAP.md](ROADMAP.md).

## Architecture (planned)

| Layer | Technology |
|---|---|
| Geometry kernel | OpenCascade compiled to WebAssembly, through [replicad](https://replicad.xyz), running in a Web Worker |
| Assembly solver and simulation | WebAssembly (C/C++ or Rust) in Web Workers, with WebGPU where it helps |
| UI | React and Three.js |
| Real-time collaboration | Yjs (shared editing data) synced over WebSocket to a Cloudflare Durable Object per document |
| Accounts, documents, sharing | Cloudflare Workers and D1 |
| Files (versions, imports, exports) | Cloudflare R2 |
| Onshape import | OAuth ("Sign in with Onshape"). Keel never sees your Onshape password |
| Input | Mouse, keyboard, and 3Dconnexion SpaceMouse through WebHID |
