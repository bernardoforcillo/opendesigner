# MCP: what the editor does for an agent

Most MCP tools edit the document directly on the server. Some things only the **editor** (the browser) can do, because they need the text layout and the fonts it has, its importers and its menus' code: the PDF, EPUB, PNG and SVG exports, the print package, the full preflight, importing a PDF or SVG, placing an image, generating a table of contents, building a table, find and change. Rather than write a second implementation of each (which would drift from what the menus do), the server hands them to an editor.

## How it works

1. An editor with the document open offers itself (`WatchJobs`, a stream, like presence).
2. An agent calls a tool; the server gives the job (`RunJob`) to one of those editors, with the options and, for tools that take a file, the file (up to 32 MiB).
3. The editor runs it through the same functions the menus use and answers (`CompleteJob`): a produced file (up to 64 MiB), a text result, or a reason it could not.
4. The tool writes the file to `outPath` on the MCP server's machine and returns it, and the file is also kept on the server for 15 minutes at `/export-api/<doc>/<id>` (same access rules as the document).

Nothing is queued: **with no editor open the tool fails at once**, saying so. A job given to an editor that then closes fails with that reason; a job unanswered after `timeout` (default 2 minutes) fails. Jobs run one at a time per editor. Edits made by a command (a table, a contents page, a replacement) are one undo step, like a click.

## Tools made by the editor

| Tool | What |
|---|---|
| `export_pdf` | the whole document as a PDF: `standard` (x4 / x3 / x1a, "ready", not validated), `bleed`, `marks`, `slug`, `spreads`, `interactive` |
| `export_package` | zip with the PDF, fonts, placed images and `Report.txt` |
| `export_epub` | `mode` fixed (default) or reflowable |
| `export_image` | PNG (scale 1–3) or SVG of a page or of some nodes |
| `preflight` | the findings of the print preflight (document and writer) as a list |
| `generate_contents` | the table of contents or the index |
| `insert_table`, `edit_table` | build a table, add / delete / resize rows and columns |
| `find_change` | list or replace text across the document (plain, whole word, regex) |
| `override_master_item` | a page's own copy of a master item |
| `place_image`, `import_svg`, `relink_image`, `import_pdf`, `import_fig`, `upload_font` | take a file from disk and bring it into the document |

## Tools made by the server (no editor needed)

`export_onix` (ONIX 3.1 / 3.0 from the book record, byte-identical to the editor's, checked against shared fixtures in `testdata/onix`), `data_merge` (a template page repeated per record of a CSV, sharing cases with the editor in `testdata/merge`), `duplicate_page`, and `set_document_settings { book }` for the book record.

## Limits

- The editor must be open for the tools in the first table; the document is not rendered headlessly.
- A tool that opens a page in the editor (`place_image` with `pageId`, the importers) moves the editor to that page, as a person picking it would.
- Several editors open on the same document: jobs go to them in turn.
