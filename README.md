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

## Run it locally

You need Node 20+, [wrangler](https://developers.cloudflare.com/workers/wrangler/), `brotli`,
and a SolidCraft checkout next to this repository (`../solidcraft`).

```sh
npm install
scripts/stage-cad.sh            # copy SolidCraft's dist/web into public/cad, put its WebAssembly in local R2
                                # (BUILD=1 rebuilds SolidCraft first: needs rustup + trunk, ~15 min)
npm run db:local                # create the local D1 tables
npm run dev                     # http://127.0.0.1:8787
```

**Dev mode (no sign-in):** put `DEV_AUTH=1` in `.dev.vars`, which git ignores. Then:
- Every request without a session counts as the user "Dev".
- `/api/dev/as?name=Bob` signs you in as Bob, creating him if needed, so a second browser
  window can act as someone else. The home page's user menu has a "Switch user (dev)" item that
  does the same.
- It only works on `localhost` and `127.0.0.1`, so a deployment with the variable set by mistake
  still requires sign-in.

## Tests

```sh
npm test                        # unit tests for the merge
npm run e2e                     # with `npm run dev` running: three browsers, see below
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
wrangler d1 migrations apply keel --remote
scripts/stage-cad.sh --remote           # upload SolidCraft's WebAssembly to R2
wrangler deploy
```

**Keep a deployment private.** Put Cloudflare Access in front of it, or set `SIGNUP` to `"closed"`
in `wrangler.jsonc` once your accounts exist. SolidCraft's code is MIT/Apache-2.0, but its
look, name and icons are under [LICENSE-BRAND](https://github.com/tangency-labs/solidcraft/blob/main/LICENSE-BRAND).
Running your own build for yourself is fine. A public service showing SolidCraft's look needs
Tangency Labs' permission, or Keel's own UI kit, theme and icons.

## Limits worth knowing

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
