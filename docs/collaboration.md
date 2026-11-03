# Collaboration: comments and versions

## Comments

A **comment** is a document object (`Document.comments`, ops `SetComment` / `DeleteComment`), so it travels, persists and is replayed like any other edit -- but it is **not** an undo step: a comment is a conversation, not a design change.

- A **thread** is a root comment plus replies (`parent_id`); replies do not nest and carry no position of their own.
- A root is **attached to a node** (`node_id`, with `x`/`y` an offset from the node's top-left corner in the node's own space, so the pin follows the node, also when it is rotated) or **free** on a page (`page_id`, world coordinates).
- Text is 1..4000 characters, the author up to 80. `resolved` hides a thread's pin by default. Deleting a root deletes its replies. Deleting a **node does not delete its comments**: they stay (undoing the deletion brings the pins back) and the panel lists them as "deleted element".
- The core rejects a bad comment whole (empty or long text, unknown node or page, a reply to a reply, a positioned reply, a comment that changes thread); golden fixture `testdata/golden/comments.json` runs from Go and TS.

In the editor, the **Comment tool** (C) drops a pin (a click on an existing pin opens its thread) and the **Comments** tab of the left panel takes the text, replies, resolves and deletes. Pins are drawn on the overlay (never exported).

For agents: `list_comments` (open threads, or `includeResolved`), `add_comment` (new thread on a node, or `replyTo` a root), `resolve_comment`, `delete_comment`. Comments written by an agent are signed "Claude" unless `author` is given.

## Agents in the room, and their names

An MCP session joins the document's presence like a person: it is listed, and outlines the nodes it is working on. It appears as **Claude** unless the MCP URL says otherwise (`/mcp?nickname=Ada`), and the **`set_nickname`** tool changes it at any time (1 to 32 characters): the agent leaves and rejoins the room under the new name. People change theirs from the people button in the top bar.

## Named versions and branches

**Document menu → Versions…** saves a **version**: a frozen copy of the whole document with a name, kept in `<bundle>/versions/` next to the oplog (so copying a bundle copies its history). A version never changes.

- **Open as copy** (RPC `BranchDocument`) creates a **new document** seeded from the version, with its own id and a copy of the assets it uses, and goes to it. **Branch the current state** does the same from the document as it is now.
- The original is untouched, and the two evolve independently until you merge.
- RPCs: `CreateVersion`, `ListVersions`, `DeleteVersion`, `BranchDocument`.

## Merging a branch back

A branch remembers the document it came from and **the document as it was then** (`origin.json` and `origin-base.pb` in its bundle). **Versions… → Merge back** (RPCs `GetBranchOrigin`, `ReviewMerge`, `MergeBranch`) compares three documents: that starting point, the branch now and the original now (`internal/merge`), and lists what the branch did: layers added, removed and changed (with the properties that changed), pages, flows, variables, fonts, text styles, component sets.

- It is a **three-way, property-level merge**. A property the branch changed is taken unless the original changed *the same property of the same layer* to something else since the start: a **conflict**. Conflicts are flagged in the review and left as the original has them, unless you tick "On a conflict, use the branch's version". A layer the branch removed that the original edited (or put something new inside) is a conflict too; so is a new layer whose parent no longer exists in the original.
- Applying it is **all or nothing**: the ops are checked against a copy of the original first, then submitted to it as ordinary edits (so every core invariant holds, collaborators see them live, and they undo like any other work). Afterwards the branch's state becomes the new common ancestor: what was merged is not offered again, and a conflict resolved the original's way is not either.
- **Not merged, and said so in the review**: a frame's clipping, an instance's component data, a shape that changed kind, comments, and anything the original also deleted. The review lists these as warnings rather than dropping them silently.
- Merging needs edit access to both documents when they are protected.

## Share links and access

By default a document is open to anyone who can reach the server (local-first, trusted network). **Document menu → Share…** can **protect** it: from then on it is reached only through **share links**, each with a role:

| Role | Can |
|---|---|
| view | read the document, follow it live, see presence |
| comment | view, and write comments |
| edit | comment, and change the document, save versions, branch, merge, import, rename |
| owner | edit, and manage links, remove protection, delete the document |

There are **no accounts**: a link *is* the permission. It is shown **once**, when it is made (`/doc/<id>?k=<token>`); the server keeps only its SHA-256. Revoking a link cuts it off at once. A protected document is not listed to strangers, and its images are served only with a link (`?k=` on the image URL, `Authorization: Bearer` elsewhere). The server enforces every role on every RPC, streams and the asset route included; the editor also hides the tools a link cannot use ("View only" / "Comment only" in the top bar).

Who may protect a document, since there are no accounts: **the machine running the server** (a request straight from loopback), or the holder of the server's **admin token** (`opendesigner serve -admin-token …` or `$OPENDESIGNER_ADMIN_TOKEN`). Behind a reverse proxy every request looks like it comes from the proxy, so the server treats a request with `X-Forwarded-For`, `Forwarded` or `X-Real-Ip` as **not** local: there, the admin token is what manages access.

## Beyond the local network

The server can be exposed to the Internet **by you**: `opendesigner serve -tls-cert cert.pem -tls-key key.pem` serves HTTPS (HTTP/2 included, which the live streams need), or put it behind a TLS-terminating proxy; protect the documents you share and give people links. That is a **self-hosted** route and everything stays on your machine. What is **not** there is a relay that connects two editors across NATs without a reachable server (a hosted relay or a peer-to-peer rendezvous): that needs infrastructure this project does not run, and was not built.

## Simultaneous edits: property-level conflict resolution

Every property of every layer is a **last-writer-wins register** on the hub (`internal/server/propversions.go`). `Op.base_seq` is the highest oplog seq the editor had applied when the user made the edit; with the client id it forms a Lamport-style stamp `(base_seq, client_id)`.

- Of two **concurrent** writes to the same property (same layer, same mask path; text content counts as one property) the higher stamp wins **whatever order they reach the server in**. A writer who had already seen the other's change has the higher `base_seq`, so a stale client can no longer overwrite a newer value. Equal bases are broken by client id, so the result is deterministic.
- Different properties of one layer never conflict (the field mask already guaranteed it).
- The loser's path is **removed from the recorded op**, so the oplog, every subscriber and a later replay all agree. An op that loses everything is still recorded (empty mask) and takes a seq, which is what confirms it for its sender: the sender's echo rolls its optimistic value back to the winner's. Undo/redo and presence are untouched; undo of a lost write is a harmless no-op on the property.
- `base_seq` 0 (agents, merges, old clients) means "saw everything": plain arrival order, as before.
- Registers live in memory only: after a server restart the first write to each property wins. Deleting or re-creating a layer resets its registers.

Tests: `internal/server/propversions_test.go` (incl. a 16-writer race under `-race`) and `web/src/rpc/syncClient.test.ts`.

## What is not there

Per-person accounts and a hosted relay for use across NATs. Not covered by the property registers: structural ops (reparenting and reordering, creates and deletes) and list-valued fields edited whole still resolve by arrival order, and an edit whose mask path is a whole list is a single register.
