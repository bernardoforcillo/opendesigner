# Shared libraries

A document can be published as a **library**. Another document imports the components, styles and
variables it needs from it. Code: `internal/library` (planning), `internal/server/library.go`
(publishing, asset copy, applying), `internal/mcp/library.go` (tools),
`web/src/features/editor/components/organisms/LibrariesDialog` (UI).

## Model

- **Publishing** is a flag on the document's identity (`meta.json`, `DocInfo.library`), not an op:
  it is not in the op-log, not undoable and not versioned. `SetLibrary` needs owner access.
- **What a library offers** (`GetLibrary`): its components, text / paint / effect / object styles and
  variable collections. A component set is offered through its members.
- **Importing copies.** `ImportFromLibrary` turns the chosen items into ordinary ops on the importing
  document, so the copy is editable, undoable, versioned and shared with every collaborator. There is
  no live link back to the library; a later change in the library comes in by importing again.
  It needs edit access to the importing document and view access to the library.

## What comes along

| Chosen | Also imported |
| --- | --- |
| component | every other member of its component set (and the set), components that instances inside the master use, instance-swap defaults, text / object / paint / effect styles the master uses, variables its nodes are bound to (the whole collection), fonts of the text styles used, images and fonts files (copied into the importing document's asset store) |
| text style | styles it is based on / continues with, uploaded font faces of its family |
| object style | the style it is based on |
| variable collection | all its variables, alias targets in other collections |

## Re-importing

Items keep their ids. Importing again **updates in place**: styles, variables, collections, component
sets and fonts. A **component already in the document is left alone** (its master may have been edited
since) and comes back in `skipped`.

If a node id of a master is already used in the importing document, the master is copied with new node
ids (the component id is unchanged).

## Where the masters go

On one page per library, whose id is derived from the library's document id, so later imports find it
again. The masters are laid out side by side to the right of what is already on the page.
`ImportFromLibraryResponse.page_id` names it.

## Safety

The whole plan is applied to a copy of the importing document first; if any step is refused (for
instance a variable that exists with another type) nothing is written. Assets are copied before the ops.
The importing hub is locked for the duration so the plan is checked against the state it is applied to.

## MCP tools

`set_library`, `get_library`, `import_from_library`; `list_documents` reports `library`.

## Not done

- Update notifications / "library has changed" for documents that imported from it.
- Detaching or tracking which items came from which library.
- Style references that are not on a node or a `TextRun` (table styles' `*_style_id`, paragraph styles named in `TextNode.paragraph_styles`) are not followed.
- A Home-page badge for library documents.
