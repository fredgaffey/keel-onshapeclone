# Keel for AI agents

Keel is collaborative CAD in the browser. Its designs are SolidCraft design files: JSON with a
feature list. Agents can read and edit Keel documents while people work on them live, and can
work on local `.sc` design files. Keel's server never models: it stores and merges designs, and
modelling runs on each person's device.

There are two ways in:
- **Remote MCP server:** nothing to install. Use it to read and write documents.
- **The `keel` command and local MCP server:** one Node file. It does everything the remote server
  does, and also works on local files: pull, push, merge and check.

## Connect

These commands use `https://keel.pebnum.com` as the site. Use your own Keel site's address if it
differs.

### With an account

Make a token on the website: click your name, then **API tokens and agents**.

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

Leave the header off, or don't log in:

```sh
claude mcp add --transport http keel https://keel.pebnum.com/mcp
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
| `save_version`, `list_versions` | ✓ | ✓ | Named versions, which can be restored on the website |
| `pull_document` | | ✓ | Document to a linked local `.sc` file; merges local changes onto newer ones |
| `push_document` | | ✓ | Linked file back to the document, merged |
| `file_status` | | ✓ | Whether the file, the document, or both have changed |
| `upload_file` | | ✓ | Local `.sc` file to a new document, and link it |
| `merge_files` | | ✓ | Three-way merge of local files: base, mine and theirs |

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
| `POST /api/loose` | Body `{name, text?, by?}`. No auth. Returns `{document, key, url, deleted_at, note}` |
| `GET /api/docs/:id/versions`, `POST /api/docs/:id/versions` | List or save versions; POST takes `{name}` |
