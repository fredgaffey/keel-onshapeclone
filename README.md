# Keel

Keel is collaborative CAD in the browser, hosted on Cloudflare. The modelling is
[SolidCraft](https://github.com/tangency-labs/solidcraft): its full browser app, kernel and UI,
running as WebAssembly on your own device. Keel adds what a cloud CAD service needs around it:

- **Accounts:** sign up and sign in with email and password. Passwords are PBKDF2 hashes;
  sessions are HttpOnly cookies.
- **Documents in the cloud:** create, rename, delete, search and import them.
- **Live co-editing:** everyone with a document open sees each change as it's made, along with
  who else is there. If two people change it at the same moment, Keel merges the changes and
  says so if they clashed.
- **Sharing:** "can edit" or "can view", enforced by the server. Removing someone disconnects
  them.
- **Versions:** named snapshots, automatic ones every 100 changes, and restore and download for
  any of them.
- **Copies on your device:** every document you open is kept in the browser. Keel opens and edits
  it offline, and your offline edits merge in when you reconnect. A document created offline is
  uploaded later.
- **Backup to a folder:** in Chrome and Edge, Keel also writes each document to a folder you
  choose on your computer whenever it's saved.
- **Installable** as an app, which also works offline.
- **AI agents:**
  - Claude Code, Codex or a script works on your documents with an API token, seen live by
    everyone with the document open.
  - Agents can also use **loose documents**, which need no account. They're reached by a key and
    deleted 30 days after they're made.
  - The `keel` command works on local `.sc` files too: pull, push, merge, and resolve conflicts.
  - Agents use the real modelling kernel through any open tab, or a headless one (`keel host`):
    rebuild checks, screenshots and SolidCraft commands.
  - Agents can also make typed edits and read diffs, and there's a tested format reference.
  - claude.ai and ChatGPT connect with OAuth.
  - [Agent guide](public/agents.md), also served at `/agents.md`.

> Keel is an independent project. It is not affiliated with or endorsed by PTC or Onshape®,
> Autodesk or Fusion 360®, or Tangency Labs (SolidCraft). Those names belong to their owners.

## How it fits together

```
browser                                         Cloudflare
┌─────────────────────────────────────┐        ┌───────────────────────────────────────┐
│ Keel page (public/)                 │  HTTP  │ Worker (worker/index.js)              │
│  documents, sharing, versions,      │───────▶│  /api/*: accounts, documents, shares, │
│  sync engine (editor.js, merge.js)  │        │  versions (D1)                        │
│  IndexedDB copy, backup folder      │  WS    │  DocRoom Durable Object per document: │
│ ┌─────────────────────────────────┐ │───────▶│  live design and edit order           │
│ │ SolidCraft (/cad/?embed=editor) │ │        │ static assets: public/                │
│ │ modelling in WebAssembly,       │ │        │ R2: versions, SolidCraft's 32 MB      │
│ │ driven by window.solidcraft     │ │        │ WebAssembly (over the asset limit)    │
│ └─────────────────────────────────┘ │        └───────────────────────────────────────┘
└─────────────────────────────────────┘
```

Keel doesn't change SolidCraft. It loads SolidCraft's own browser build in embed mode and moves
designs in and out through SolidCraft's
[browser command API](https://github.com/tangency-labs/solidcraft/blob/main/docs/browser-api.md):
`document.export`, `document.import`, `document.revision` and `document.saved`.

**How syncing works:**
- Each client watches SolidCraft's design revision. When it changes, the client sends the design
  together with the server sequence number it started from.
- The document's Durable Object accepts updates one at a time.
- If someone else's change got in first, the room sends back the newer design.
  [`public/js/merge.js`](public/js/merge.js) does a three-way merge:
  - features are matched by id
  - concurrent new features are renumbered, along with references to them
  - dimension names that clash are renamed
  - an edit to the same field by both people goes to the later one, and Keel reports it as a
    conflict
  - a deletion beats an edit made at the same time
- If a merged design fails to rebuild, Keel keeps the other person's design and saves yours as a
  "conflicted copy" document.


## Default scripts

Keel ships parametric generators any document can use. They build proper CAD (sketches, lofts,
extrudes, patterns), not meshes, so the result stays editable in the timeline.

- **In Keel:** open a document, click **Scripts**, pick a script, set its parameters and click
  **Create**. The panel runs the script's commands one at a time through SolidCraft's command API
  (`window.solidcraft.execute(command, params)`), in the same queue as Keel's own engine work.
- **Headless:** print the command list and run it with the SolidCraft CLI:

  ```sh
  node scripts/run-script.mjs propeller blades=3 diameter=152.4 pitch=4 > prop.json
  solidcraft-cli run prop.json --param-check strict --out prop.step --out prop.stl
  solidcraft-cli eval prop.json        # bodies, volume, mass
  ```

  `node scripts/run-script.mjs` with no arguments lists the scripts and their parameters.

Scripts live in [`public/js/scripts/`](public/js/scripts/): plain ES modules, each
`{id, name, description, params, build(params) → [{command, params}]}`, registered in `index.js`.
`build` is pure, so the same list runs in the browser, in tests and in the CLI.

**Propeller** (`propeller`): diameter, blade count, hub, bore, constant geometric pitch (or root/tip
pitch angles), chord at the root cutout, 0.75 R and the tip, Clark-Y or NACA 4-digit sections with
root/tip thickness, number of sections, round or square tip, CW/CCW. Each blade is lofted through
airfoil sections (closed, periodic fit-point splines with a rounded trailing edge) on planes along
the span, twisted to the pitch angle and stacked on the quarter chord. A thick neck centred in the
hub, a flare at the hub wall and smoothly blended stations carry it into the root section, so the
blades are one solid with the hub. Examples with pictures, STEP and STL: [`examples/propeller/`](examples/propeller/).
SolidCraft 0.46's fillet can't round the blade-hub seam (the loft has one face per spline span), so
the `root_flare` parameter blends it in the loft instead.

## Run it locally

You need Node 20+, [wrangler](https://developers.cloudflare.com/workers/wrangler/), `brotli`,
and a SolidCraft checkout next to this repository (`../solidcraft`).

```sh
npm install
scripts/stage-cad.sh            # copy SolidCraft's dist/web into public/cad, put its WebAssembly in local R2
                                # (BUILD=1 rebuilds SolidCraft first: needs rustup + trunk, ~15 min)
npm run db:local                # create the local D1 tables
npm run dev                     # http://127.0.0.1:8787 (--local-upstream keeps local links local)
```

**Dev mode (no sign-in):** put `DEV_AUTH=1` in `.dev.vars`, which git ignores. Then:
- Every request without a session counts as the user "Dev".
- `/api/dev/as?name=Bob` signs you in as Bob, creating him if needed, so a second browser
  window can act as someone else. The home page's user menu has a "Switch user (dev)" item that
  does the same.
- It only works on `localhost` and `127.0.0.1`, so a deployment with the variable set by mistake
  still requires sign-in.

## AI agents

```sh
# Claude Code, nothing to install; sign in with /mcp (OAuth), or add --header "Authorization: Bearer keel_..."
claude mcp add --transport http keel https://keel.pebnum.com/mcp
# no account: https://keel.pebnum.com/mcp/loose, where create_document makes loose documents
# local files too: the keel command (public/keel.mjs, built from cli/ by `npm run build:cli`)
curl -fsSLO https://keel.pebnum.com/keel.mjs && node keel.mjs help
```

- **Tokens:**
  - Tokens are made and revoked on the website, never with another token. They can be read-only
    and can expire.
  - Changes an agent makes are labelled "Name (token name)".
- **HTTP writes:**
  - Each write names the version it started from. Keel merges it with anything newer, using the
    same merge as the browser, run in the document's room.
  - A field both sides changed goes to `mine` or `theirs`. With `ask`, nothing is saved and the
    conflicts come back so they can be resolved.
- **The modeller for agents:**
  - `POST /api/docs/:id/run` goes to the document's room, which hands it to a browser tab with the
    document open and agents allowed. That tab runs it in SolidCraft and answers back.
  - Only inspection, screenshots and engine commands are allowed; file, plugin and app commands are
    refused.
  - `keel host <id>` opens such a tab in headless Chrome.
- **OAuth** (`worker/oauth.js`):
  - dynamic client registration, PKCE S256, and rotating refresh tokens
  - the access tokens are ordinary API tokens, so revoking one on the website disconnects the app
- **Loose documents:**
  - `POST /api/loose` with no account. A guest owns the document; its key is a token that reaches
    only that one document.
  - Each is **deleted `LOOSE_DAYS` (30) days after it's made**. An hourly scheduled job deletes the
    document, its versions and its room.
  - `LOOSE: "closed"` turns them off. Making them is limited to 10 a minute per IP address.

See [the agent guide](public/agents.md) for the tools and the merge rules.

## CI

`.github/workflows/ci.yml` runs on every push:
- the unit tests
- a check that `public/keel.mjs` is built from `cli/`
- the agent tests against the Worker in local mode (without the browser-host step, which needs SolidCraft)

Deploys stay manual, since they need SolidCraft's build staged in `public/cad`.

## Tests

```sh
npm test                        # unit tests for the merge
npm run e2e                     # with `npm run dev` running: three browsers, see below
npm run test:agents             # with `npm run dev` running: tokens, merging, loose documents, OAuth, MCP, the CLI, a host tab
npm run catalog                 # with `npm run dev` running: rebuild public/agents/catalog.json from SolidCraft
```

The end-to-end test (`tests/e2e.mjs`) drives real browsers through the real app and these
steps:
1. Sign-up, sign-in and wrong-password checks, plus a cross-site request being refused.
2. Creating and renaming a document, and sharing it with edit or view access.
3. Two editors: a box made by one appears for the other, and a box added by each at the same
   moment ends up as one agreed design.
4. An edit made while offline arrives when the connection comes back. So does an edit made
   after reloading the page with no network at all.
5. A viewer can't save, a restored version reaches everyone, and removing access cuts the
   person off.

Set `CHROME` to a Chrome binary if Playwright's own isn't installed.

## Deploying to Cloudflare

These steps run once, on your account:

```sh
wrangler login
wrangler d1 create keel                 # put the database_id it prints into wrangler.jsonc
wrangler r2 bucket create keel-files    # R2 must be enabled in the dashboard first
wrangler d1 migrations apply keel --remote   # again whenever migrations/ gains a file
scripts/stage-cad.sh --remote           # upload SolidCraft's WebAssembly to R2
wrangler deploy
```

**Keep a deployment private.** Put Cloudflare Access in front of it, or set `SIGNUP` to `"closed"`
in `wrangler.jsonc` once your accounts exist. SolidCraft's code is MIT/Apache-2.0, but its
look, name and icons are under [LICENSE-BRAND](https://github.com/tangency-labs/solidcraft/blob/main/LICENSE-BRAND).
Running your own build for yourself is fine. A public service showing SolidCraft's look needs
Tangency Labs' permission, or Keel's own UI kit, theme and icons.

## Limits worth knowing

- **Keel carries its own fixes to SolidCraft** in `patches/solidcraft/`. Currently there is one:
  holding the up or down arrow no longer flips the view at the pole.
  - `BUILD=1 scripts/stage-cad.sh` applies each patch before building, so updating the SolidCraft
    checkout can't silently drop one.
  - If a patch stops applying because upstream fixed the bug, the build says so. Delete that patch.

- **Remote changes reload the design.** Applying someone else's change reloads the design inside
  SolidCraft, which clears your undo history. Keel waits until you're not mid-drag or in a dialog
  before applying it.
- **Merging is per feature.** Two people editing the same sketch at once merge at the level of
  that sketch's fields, not individual lines in it.
- **Designs up to 16 MiB.** That is SolidCraft's import limit. Designs that link other design
  files keep those links as paths, which other people can't open.
- **Simple sign-in.** Email and password only, with no email verification, password reset or
  rate limiting yet. Use Cloudflare Access in front of a deployment that anyone can reach.

See [ROADMAP.md](ROADMAP.md) for what's next.
