# ONIX: book metadata and the trade message

ONIX for Books (3.1, with 3.0 selectable) is the book trade's standard for telling retailers and distributors what a title is. The document keeps a **book record** and exports it as an ONIX message; the same record fills the EPUB package and the PDF's title and author.

## Book metadata (document menu → *Book metadata (ONIX)…*)

Stored in the document settings (`DocSettings.book`, one undo step, shared like every setting):

| Field | ONIX |
|---|---|
| ISBN-13 (13 digits, valid check digit; hyphens are removed as you type) | `ProductIdentifier` type 15 |
| Format: digital (EPUB, default), paperback `BC`, hardback `BB` | `ProductForm` (and `ProductFormDetail` E101 for digital) |
| Title, subtitle | `TitleDetail` |
| Series and number in series | `Collection` |
| Edition | `EditionNumber` |
| Contributors: role (author A01, editor B01, illustrator A12, translator B06, foreword A23, introduction A24, photographer A13), name, biography | `Contributor` (numbered in order) |
| Language (ISO 639-2/B: `eng`, `ita`…) | `Language` |
| Pages | `Extent` |
| Subjects: scheme (BISAC 10, BIC 12, Thema 93, keywords 20), code, heading | `Subject` |
| Description (blank line = paragraph) | `TextContent` type 03, as XHTML paragraphs |
| Publisher, imprint, publication date | `PublishingDetail` |
| Prices: type (02 including tax, 01 excluding), amount, currency | `ProductSupply` / `Price` |
| Sender name and email | `Header` (defaults to the publisher) |

Required to export: an ISBN and a title. The dialog also lists what a trade partner will miss (contributor, language, publisher, date, subject, price, description). The values are checked when saved, in Go and in TS with the same rules (`internal/core/book.go`, `store/docSettings.ts`, fixture `testdata/golden/book_metadata.json`): ISBN check digit, 3-letter lower-case language, a real calendar date, role `A01`-style codes, 2-digit schemes and price types, decimal amounts, 3-letter upper-case currencies, no control characters or line breaks in one-line fields, at most 50 contributors, subjects and prices.

## ONIX export

*Save and download ONIX…* writes `<isbn>.onix.xml`: an `ONIXMessage` (release **3.1** by default, **3.0** from the release selector; reference tag names; ONIX 3.x keeps one namespace, `http://ns.editeur.org/onix/3.0/reference`) with a header and one `Product` (notification type 03, confirmed; publishing status 04, active; availability 20, available; the publisher as supplier). Every element written here is the same in 3.0 and 3.1, so the two files differ only in the `release` attribute; 3.1-only additions (new code-list values and elements) are not used. Element order follows the schema's sequences (`web/src/export/onix.ts`).

**What it does not do:** it checks the *shape* of codes, not membership in the EDItEUR code lists, and it does not validate against the XSD. Run the file through EDItEUR's validator before sending it to a partner. Not covered: several products per message, related products, territories and sales rights, reviews and other collateral (cover images, sample text), multiple supply details or discounts, audience ranges, ONIX 2.1 / short tags, and ISBN-10.

## Elsewhere

- **EPUB** (fixed layout and reflowable): the ISBN becomes the package identifier (`urn:isbn:`), the title, subtitle, language, creators and other contributors (with MARC relator roles), publisher, date, description, subjects and series are written to the OPF.
- **PDF**: the book title replaces the document name in the Info dictionary, the authors become `Author`, the description `Subject`.
- **MCP**: `set_document_settings { book: {...} }` replaces the record (an empty object clears it). The ONIX file itself is produced by the editor.
