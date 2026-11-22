# Roadmap

Keel is built around [SolidCraft](https://github.com/tangency-labs/solidcraft). SolidCraft
already supplies these, and Keel uses them as they are:
- part modelling: sketches, features, sheet metal and weldments
- assemblies and joints
- STEP, STL and 3MF import and export
- a SpaceMouse driver
- the modelling UI

Keel's work is the cloud, collaboration and anything SolidCraft defers.

## Done (0.1)
- [x] Accounts: sign up, sign in and sign out, with D1 sessions
- [x] Documents:
  - [x] create, rename, delete, list, search
  - [x] import a design file and download one
- [x] Sharing (owner, can edit, can view), enforced on the server; removing access disconnects the person
- [x] Live co-editing through a Durable Object per document:
  - [x] presence
  - [x] three-way merge of simultaneous edits
  - [x] a conflicted copy when a merge won't rebuild
- [x] Versions: named, automatic every 100 changes, restore, download
- [x] On-device copies in IndexedDB:
  - [x] open and edit offline
  - [x] offline edits sync on reconnect
  - [x] documents created offline upload later
- [x] Backup of every document to a folder on disk (File System Access API)
- [x] Installable app; the shell and SolidCraft are cached for offline use
- [x] Cloudflare deployment: Workers, static assets, D1, R2 and Durable Objects
- [x] Tests: merge unit tests; an end-to-end test with three browsers

## Next
- [ ] Deploy to Cloudflare behind Access
- [ ] Keep the camera and undo history when a remote change arrives. This needs a SolidCraft
      API that applies changes without reopening the design, which could be proposed upstream
- [ ] Show other people's selection and current tool in the viewport
- [ ] Account management: password reset, email verification, rate limiting, deleting an
      account; optionally sign-in through Cloudflare Access instead
- [ ] Document thumbnails, folders, a trash with undelete
- [ ] Linked designs (one design inserting another) across documents, stored in R2
- [ ] Branches of a document, and comparing two versions

## Onshape interop
- [ ] "Sign in with Onshape" (OAuth)
- [ ] Import Part Studios and Assemblies (geometry through STEP, and the feature list where it
      can be rebuilt)
- [ ] Browse the public library

## Simulation (on device), which SolidCraft's roadmap defers
- [ ] Tetrahedral meshing in WebAssembly
- [ ] Linear static FEA (stress and displacement) in a Web Worker, sped up with WebGPU; modal analysis
- [ ] Quick-look CFD (lattice Boltzmann on WebGPU), then finite-volume CFD
- [ ] Validation against benchmark cases

## AI agents
- [x] API tokens (read/write or read-only, optional expiry), managed on the website
- [x] Remote MCP server at /mcp, and the `keel` CLI with a stdio MCP server
- [x] Merging HTTP writes; conflicts resolved as mine, theirs, or returned to the agent (ask)
- [x] Local `.sc` files: pull, push, status, three-way merge, structure check
- [x] Loose documents: no account, a key, deleted 30 days after they're made
- [ ] Agent panel in Keel using your own Anthropic or OpenAI key (kept in the browser) and
      driving SolidCraft's command API, with features named automatically
- [ ] Agents join a document as collaborators (presence, live edits); each turn is one version
- [x] OAuth on /mcp (claude.ai and ChatGPT connectors); /mcp/loose for no account
- [x] Agent host: SolidCraft commands, kernel checks and screenshots in an open or headless tab
- [x] Typed edits (edit_document), diffs (get_changes), a tested format reference (describe_format)
- [x] Agents shown as collaborators; a version saved before each agent session
- [ ] A second, hidden modeller in the host tab, to check a design before it is saved
- [ ] Keel Script: a typed successor to FeatureScript for custom features

## UI
- [ ] Keel's own look (UI kit, theme, icons), so a public deployment doesn't use SolidCraft's brand
