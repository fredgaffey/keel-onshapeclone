# Keel for AI agents

Keel is collaborative CAD in the browser. Its designs are SolidCraft design files: JSON with a
feature list. Agents can read and edit Keel documents while people work on them live, and can
work on local `.sc` design files. Keel's server never models: it stores and merges designs, and
modelling runs on each person's device.

There are two ways in:
- **Remote MCP server:** nothing to install. `https://keel.pebnum.com/mcp` needs sign-in (OAuth or
  a token); `https://keel.pebnum.com/mcp/loose` needs no account.
- **The `keel` command and local MCP server:** one Node file. It does everything the remote server
  does, and also works on local files (pull, push, merge, check), and can start a headless browser
  tab for the modeller (`keel host`).

**The server never models, but agents can still use the real modelling kernel.** Any browser tab
with the document open runs it for them, unless its **Agents** switch is off. It runs:
- kernel rebuild checks
- volumes and areas
- screenshots
- SolidCraft's own modelling commands

With no tab open, `keel host <id>` (or the `start_host` tool) opens one in headless Chrome.

## Connect

These commands use `https://keel.pebnum.com` as the site. Use your own Keel site's address if it
differs.

### With an account

**Apps with connectors** (claude.ai, ChatGPT, Claude Code): add `https://keel.pebnum.com/mcp` and
sign in to Keel when asked (OAuth). The connection appears under **API tokens and agents** on the
website, where you can disconnect it.

```sh
claude mcp add --transport http keel https://keel.pebnum.com/mcp    # then /mcp in Claude Code to sign in
```

**Or with a token.** To make one on the website, click your name, then **API tokens and agents**.

```sh
# Claude Code, remote (nothing to install)
claude mcp add --transport http keel https://keel.pebnum.com/mcp --header "Authorization: Bearer keel_..."

# or the local command, which also handles local files
curl -fsSLO https://keel.pebnum.com/keel.mjs
node keel.mjs login --url https://keel.pebnum.com --token keel_...
claude mcp add keel -- node "$PWD/keel.mjs" mcp
```

Instead of `keel login`, you can set `KEEL_URL` and `KEEL_TOKEN` in the agent's environment. Don't
commit tokens. Revoke a leaked one on the website.

### Without an account: loose documents

Use the `/mcp/loose` endpoint, or the `keel` command without logging in:

```sh
claude mcp add --transport http keel-loose https://keel.pebnum.com/mcp/loose
```

`create_document` (or `keel new "Bracket" --loose`) makes a **loose document**:
- No account is involved. A guest owns it.
- The result includes a **key** (`keel_...`). The key is the only way back in, and it is shown only
  once.
- Pass the key wherever a tool asks for a document id.
- The result also includes a web address, `/d/<id>#key=...`, so a person can open the document and
  watch or edit. Anyone who has the key or that address can edit.
- **It is deleted automatically 30 days after it is made**, with all its versions, however much it
  has been used. The exact time is in the result (`deleted_at`) and is shown on the document's page.
  To keep a copy, download it, or keep the local file.

**To keep working on it over several sessions:**
- Keep the key, or keep a linked local file.
- `keel new "Bracket" --loose --from bracket.sc` uploads a local file and links it. The key is
  saved next to the file in `.bracket.sc.keel`, so `keel push bracket.sc` and `keel pull bracket.sc`
  work later with no account.

## Tools

| Tool | Remote | Local | What it does |
|---|---|---|---|
| `list_documents` | ✓ | ✓ | Your documents (needs an account token) |
| `read_document` | ✓ | ✓ | Design JSON and its `seq` |
| `write_document` | ✓ | ✓ | Save a design from `base_seq`, merging with changes made since |
| `create_document` | ✓ | ✓ | New document; `loose: true` (or no token) makes a loose one |
| `edit_document` | ✓ | ✓ | Typed edits, including `auto_name`; never conflicts; `check: true` rebuilds it with the kernel |
| `review_design` | ✓ | ✓ | Marks the design like a CAD reviewer (names, parameters, repeats, placements) |
| `get_changes` | ✓ | ✓ | What changed since a seq: added, removed, renamed, each field before and after |
| `describe_format`, `list_commands` | ✓ | ✓ | The format reference: tested examples and the commands' parameters |
| `inspect_model` ⚙ | ✓ | ✓ | Kernel rebuild check: errors per feature, bodies, volumes (`measure`) |
| `screenshot` ⚙ | ✓ | ✓ | The model as the modeller draws it, from any view |
| `run_commands` ⚙ | ✓ | ✓ | SolidCraft commands, run as one batch that rolls back on failure |
| `start_host` | | ✓ | Opens a headless browser tab for the ⚙ tools |
| `merge_files` | | ✓ | Three-way merge of local files: base, mine and theirs |
| `import_file` ⚙ | ✓ | ✓ | STEP, IGES, STL, 3MF, OBJ, glTF, point clouds, DXF, KiCad into a document (base64; `units` for STL/OBJ) |
| `import_local_file` | | ✓ | The same, from a file on this computer (`keel import <id> <file>`) |
| `save_version`, `list_versions`, `restore_version` | ✓ | ✓ | Named versions; restore puts one back (keeping the current state as a version first) |
| `pull_document` | | ✓ | Document to a linked local `.sc` file; merges local changes onto newer ones |
| `push_document` | | ✓ | Linked file back to the document, merged |
| `file_status` | | ✓ | Whether the file, the document, or both have changed |
| `upload_file` | | ✓ | Local `.sc` file to a new document, and link it |

⚙: runs in a browser tab that has the document open with agents allowed (see the top of this
page). The tab's changes sync like that person's edits. Agents can't run file, plugin or app
commands there.

Agents show among the people on a document while they work. Before an agent's first change after
10 minutes idle, Keel saves a version named "Before <agent>'s changes", so one restore undoes the
whole session.

## Merging and conflicts

Every write says which version it started from (`base_seq`, or the base stored in the linked
file). If someone changed the document since then, Keel merges the two changes:
- Features are matched by id.
- New features on both sides are kept. Mine are renumbered, along with references to them.
- Clashing dimension names are renamed.
- If one side deleted a feature and the other edited it, the deletion wins.

A field changed on both sides is a **conflict**. `on_conflict` decides it:
- `mine` (the default): your value is kept. The conflict is still reported, with base, mine and
  theirs.
- `theirs`: their value is kept.
- `ask`: nothing is saved. You get each conflict and the current design. Resolve them, then write
  again with the new `base_seq`.
  - With a linked file, `push --on-conflict ask` (or `push_document`) rewrites the file onto the
    newest design with your changes merged in, keeping yours for each conflict, and lists the
    conflicts. Edit the file as needed, then push again.

`keel merge base.sc mine.sc theirs.sc -o out.sc` does the same merge on local files without a
server.

## Editing a design

**Recommended order:**
1. `describe_format` to see the format.
2. `run_commands` to model with the real kernel, checking with `screenshot` and `inspect_model`.
3. `edit_document` for small changes such as renaming, dimensions and parameters.
4. `write_document` only for big rewrites.

Dimensions are expression strings (`"12"`, `"width / 2"`), not numbers.

A design is `{format, name, units, params, features:[{id, name, type, suppressed, ...}], next_id, ...}`.
- Keep `format` unchanged.
- New features take ids from `next_id`. Then raise `next_id`.
- Name every feature descriptively: "Mounting holes", not "Extrude 3".
- To add a feature, copy the shape of an existing feature of the same type.
- `keel check file.sc` checks the structure: duplicate ids, `next_id`, unnamed features.

For edits the real modelling kernel checks, use SolidCraft's own MCP server on your machine:
1. `pull_document` to a `.sc` file.
2. Open, edit and save that file with `solidcraft-cli mcp` (`claude mcp add solidcraft -- solidcraft-cli mcp`).
3. `push_document`.

## HTTP API

Send `Authorization: Bearer <token or key>` with each request.

| Request | What it does |
|---|---|
| `GET /api/docs` | List your documents |
| `GET /api/docs/:id/content` | `{seq, text}` |
| `PUT /api/docs/:id/content` | Body `{base, text, base_text?, on_conflict?}`. Returns 409 with `current` and, for `ask`, `conflicts` |
| `POST /api/docs` | Body `{name, text?}` |
| `POST /api/docs/:id/edit` | Body `{edits}` (see `edit_document`) |
| `GET /api/docs/:id/changes?since=N` | What changed since seq `N` |
| `POST /api/docs/:id/run` | Body `{calls: [{method, params}], at_seq?}`: run in a host tab. Methods: `document.inspect`, `ui.inspect`, `engine.execute`, `engine.batch`, `ui.view`, `ui.camera`, `keel.screenshot` |
| `POST /api/loose` | Body `{name, text?, by?}`. No auth. Returns `{document, key, url, deleted_at, note}` |
| `GET /api/docs/:id/versions`, `POST /api/docs/:id/versions` | List or save versions; POST takes `{name}` |
