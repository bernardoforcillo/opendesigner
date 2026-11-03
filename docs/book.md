# Book

A **book** groups several documents (the **chapters**, in reading order) so that they share styles and one page count. Each chapter stays an ordinary document: it opens, is edited and is exported on its own.

## What a book is
A small record in the workspace, `<workspace>/.books/<id>.json`: a name, the chapters' document ids, the **style source** (one of the chapters; the first when unset) and the number of the first page (default 1). It names documents and holds nothing of them, so deleting a book leaves every chapter as it was. The folder is not a document bundle, so the Home's document list never takes it for one. A chapter whose document was deleted stays in the list, marked missing, and is skipped.

## Sync (`SyncBook`)
"Bring into line" writes ordinary ops into the chapters (so they are in each chapter's history and reach whoever has it open). Every op is first checked on a copy of its document; if any would be refused nothing is written. A second sync with nothing changed writes nothing.

- **Styles**: the style source's text styles (paragraph and character), paint styles, effect styles and object styles are copied into every other chapter, by id. A style the chapter has under the same id is overwritten; a style only the chapter has is left alone. Styles that are based on another are applied after it.
- **Numbering**: each chapter's first page (the first page that is not a master) is made a section start with `number_start` = the book's first page number plus the pages (not masters) of the chapters before it. So chapter 2 begins on the page after chapter 1 ends. Later sections inside a chapter keep their own numbering, and the page's number style is kept.

The two halves can be asked for separately (`styles`, `numbering`); neither flag means both. `GetBook` reports for every chapter its pages, where its numbering should start, whether it does (`numbered`) and how many of the source's styles it lacks or has different (`styles_behind`), without changing anything.

## Where
- Server: `internal/server/books.go` (rules, sync), `internal/store/books.go` (the record); RPCs `ListBooks`, `GetBook`, `SaveBook`, `DeleteBook`, `SyncBook`.
- Editor: the Home page, in the **Books** section (shown for the publishing kind of work): create or edit a book (name, chapters and their order, style source, first page number), see each chapter's page count, start page and styles behind, bring the book into line, delete it.
- MCP: `list_books`, `get_book`, `save_book`, `delete_book` (needs `confirm: true`), `sync_book`.
- Access: reading a book needs view access to every chapter, saving, syncing or deleting it needs edit access to every chapter, and the book list leaves out books that name a document the caller may not see. A book cannot be used to reach a protected document.

## Booklet creep
The booklet imposition (`export_pdf` `booklet`, formats.md) takes a `creep` distance in px: the sheets nested inside the first one move their content that much further toward the spine each. See formats.md.

## Limits
- Syncing never deletes: a style removed from the source stays in the chapters, and a style a chapter has under another id is not merged with the source's.
- Fonts are not copied (an uploaded font is a file in the document's asset store). Text styles name fonts by family, so a chapter needs the same fonts uploaded.
- Variables, components, masters, layers, table styles and document settings are not shared.
- Numbering counts physical pages, not the pages of a roman-numeral front-matter section separately, and it is set when a sync is run: adding a page to a chapter shifts the later chapters only at the next sync.
- Cross-references, the table of contents, the index and the endnotes still work inside one document; there is no book-wide contents or index, and no export of the whole book as one PDF or EPUB.
- A sync is not atomic across a crash between two chapters' writes, and it can race a person typing in a chapter at that moment.
