# Collaboration: comments and versions

## Comments

A **comment** is a document object (`Document.comments`, ops `SetComment` / `DeleteComment`), so it travels, persists and is replayed like any other edit -- but it is **not** an undo step: a comment is a conversation, not a design change.

- A **thread** is a root comment plus replies (`parent_id`); replies do not nest and carry no position of their own.
- A root is **attached to a node** (`node_id`, with `x`/`y` an offset from the node's top-left corner in the node's own space, so the pin follows the node, also when it is rotated) or **free** on a page (`page_id`, world coordinates).
- Text is 1..4000 characters, the author up to 80. `resolved` hides a thread's pin by default. Deleting a root deletes its replies. Deleting a **node does not delete its comments**: they stay (undoing the deletion brings the pins back) and the panel lists them as "deleted element".
- The core rejects a bad comment whole (empty or long text, unknown node or page, a reply to a reply, a positioned reply, a comment that changes thread); golden fixture `testdata/golden/comments.json` runs from Go and TS.

In the editor, the **Comment tool** (C) drops a pin (a click on an existing pin opens its thread) and the **Comments** tab of the left panel takes the text, replies, resolves and deletes. Pins are drawn on the overlay (never exported).

For agents: `list_comments` (open threads, or `includeResolved`), `add_comment` (new thread on a node, or `replyTo` a root), `resolve_comment`, `delete_comment`. Comments written by an agent are signed "Claude" unless `author` is given.

## Named versions and branches

**Document menu → Versions…** saves a **version**: a frozen copy of the whole document with a name, kept in `<bundle>/versions/` next to the oplog (so copying a bundle copies its history). A version never changes.

- **Open as copy** (RPC `BranchDocument`) creates a **new document** seeded from the version, with its own id and a copy of the assets it uses, and goes to it. **Branch the current state** does the same from the document as it is now.
- The original is untouched, and the two evolve independently. There is no merge of a branch back yet: take what you need across with copy and paste.
- RPCs: `CreateVersion`, `ListVersions`, `DeleteVersion`, `BranchDocument`.

## What is not there

Property-level merge of two diverging documents, accounts and permissions (read-only and comment-only links), and a relay beyond the local network.
