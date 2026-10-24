# Master pages

A **master page** is a template: its content is drawn behind every page that applies it. Put a header band, a logo, a margin guide or a page number on the master and every page that uses it shows it, always in sync.

## In the editor

Open the page list (the page name in the bar above the canvas).

- **Add a master page** creates `A-Master`, `B-Master`, … and opens it for editing. A master is an ordinary page to draw on; the list shows masters under a **Masters** heading, and each page that applies one shows the master's letter.
- **Master** (under the list) chooses the master of the current page, or **None**. A page created with *Add a page* applies the master of the page it was created from.
- **Convert to a master** / **Convert to a normal page** changes the current page in place, content included.
- Deleting a master that pages apply detaches them in the same gesture, so one undo brings everything back.

On a page that applies a master, the master's content is shown and exported but cannot be selected or moved there: edit it on the master.

### Page numbers

A text on a master that contains `<#>` shows the page's number on each page that applies it (`Page <#>` → `Page 3`). Master pages are not counted: numbering follows the normal pages in the order of the list. The master itself shows the raw token.

## Model

```
Page { id, name, is_master, master_id }
UpdatePage { page }   // op 41: absolute upsert of name / is_master / master_id; the inverse is the previous page
```

Rules, enforced the same way by the Go core and the editor:

- a master applies no master (`master_id` must be empty on a master);
- `master_id` names an existing master page other than the page itself;
- a master that pages apply cannot be deleted or demoted (detach them first);
- the document always keeps at least one page that is not a master (a master cannot be the last page, and the last normal page cannot be deleted or turned into a master).

`CreatePage` carries the same fields. Merge treats a page change as one unit (name and master together).

## How it is drawn

Nothing is copied into the document. Like live booleans and variables the master content is **derived** (`web/src/store/masters.ts`, part of `resolveScene`): each page that applies a master gets flagged copies (`fromMaster`, ids `<pageId>~<nodeId>`) of the master's nodes, behind its own, with `<#>` replaced. So the canvas, the GPU renderer, SVG/PNG/PDF/EPUB export and the prototype all see them, and hit-testing and the marquee skip them. Variables, text styles and live booleans inside a master work as usual. The cost is proportional to (pages that apply a master) × (master nodes).

## Export and code

- *Export all pages as PDF / EPUB* skips master pages (their content shows through the pages that use them). Exporting a page or a selection exports what is on the page on screen, master content included.
- Generated code (`opendesigner export`) ignores master pages as screens.

## MCP

`create_page` takes `isMaster` and `masterId`; `update_page` changes the name, `isMaster` and `masterId` (empty string detaches); `list_pages` / `get_document` report `isMaster` and `masterId`.

## Not yet

Facing pages and spreads, different masters for left and right pages, overriding a master item on one page, several masters per page, and a master that applies another master are not supported.
