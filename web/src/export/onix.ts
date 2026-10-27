import type { BookLite } from "@/store/types";

// ONIX FOR BOOKS 3.1 / 3.0 (reference tag names): the book trade's standard message for describing a title to
// retailers and distributors. One message with one <Product> built from the document's book record
// (DocSettings.book, edited in "Book metadata (ONIX)…"). See docs/onix.md for what is covered.
//
// The element ORDER inside each composite follows the ONIX 3.0 schema, which is a sequence, not a set: a
// valid message needs them in this order. What this module cannot do is check the codes against the
// code lists (it checks their shape when they are stored) -- run the file through the EDItEUR validator
// before sending it to a trade partner.

export type OnixRelease = "3.1" | "3.0";

// ONIX 3.x keeps one namespace (the "3.0" one) across its minor releases; the release is the `release` attribute.
export const ONIX_NAMESPACE = "http://ns.editeur.org/onix/3.0/reference";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tag = (name: string, value: string | number | undefined, indent: string): string =>
  value === undefined || value === "" ? "" : `${indent}<${name}>${esc(String(value))}</${name}>\n`;

/** `20260102T0304Z`: the ONIX default date-time format. */
export function onixDateTime(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
}

export interface OnixProblem { severity: "error" | "warning"; message: string }

/** What a trade partner will miss, or what makes the message unusable (no ISBN, no title). */
export function onixProblems(b: BookLite): OnixProblem[] {
  const out: OnixProblem[] = [];
  if (!b.isbn13) out.push({ severity: "error", message: "No ISBN-13: the product cannot be identified." });
  if (!b.title) out.push({ severity: "error", message: "No title." });
  if (!(b.contributors ?? []).length) out.push({ severity: "warning", message: "No contributor (author)." });
  if (!b.language) out.push({ severity: "warning", message: "No language." });
  if (!b.publisherName) out.push({ severity: "warning", message: "No publisher." });
  if (!b.publicationDate) out.push({ severity: "warning", message: "No publication date." });
  if (!(b.subjects ?? []).length) out.push({ severity: "warning", message: "No subject code (BISAC, Thema or BIC)." });
  if (!(b.prices ?? []).length) out.push({ severity: "warning", message: "No price." });
  if (!b.description) out.push({ severity: "warning", message: "No description." });
  return out;
}

const form = (b: BookLite) => b.productForm || "ED";

/**
 * The ONIX message for `book`, or null when it has no ISBN or no title (see `onixProblems`).
 * `sent` is the header's timestamp (injectable so output is reproducible). `release` is 3.1 (default) or 3.0: every
 * element written here is the same in both, so only the `release` attribute differs.
 */
export function buildOnix(book: BookLite, sent: Date, release: OnixRelease = "3.1"): string | null {
  if (!book.isbn13 || !book.title) return null;
  const I1 = "  ", I2 = "    ", I3 = "      ", I4 = "        ", I5 = "          ";
  const b = book;
  let x = `<?xml version="1.0" encoding="UTF-8"?>\n<ONIXMessage release="${release}" xmlns="${ONIX_NAMESPACE}">\n`;

  x += `${I1}<Header>\n${I2}<Sender>\n${tag("SenderName", b.senderName || b.publisherName || "OpenDesigner", I3)}${tag("EmailAddress", b.senderEmail, I3)}${I2}</Sender>\n${tag("SentDateTime", onixDateTime(sent), I2)}${I1}</Header>\n`;
  x += `${I1}<Product>\n`;
  x += tag("RecordReference", `urn:isbn:${b.isbn13}`, I2) + tag("NotificationType", "03", I2);
  x += `${I2}<ProductIdentifier>\n${tag("ProductIDType", "15", I3)}${tag("IDValue", b.isbn13, I3)}${I2}</ProductIdentifier>\n`;

  // DescriptiveDetail
  x += `${I2}<DescriptiveDetail>\n${tag("ProductComposition", "00", I3)}${tag("ProductForm", form(b), I3)}`;
  if (form(b) === "ED") x += tag("ProductFormDetail", "E101", I3); // EPUB
  if (b.seriesName) {
    x += `${I3}<Collection>\n${tag("CollectionType", "10", I4)}${I4}<TitleDetail>\n${tag("TitleType", "01", I5)}${I5}<TitleElement>\n` +
      `${tag("TitleElementLevel", "02", I5 + "  ")}${tag("PartNumber", b.seriesNumber, I5 + "  ")}${tag("TitleText", b.seriesName, I5 + "  ")}${I5}</TitleElement>\n${I4}</TitleDetail>\n${I3}</Collection>\n`;
  }
  x += `${I3}<TitleDetail>\n${tag("TitleType", "01", I4)}${I4}<TitleElement>\n${tag("TitleElementLevel", "01", I5)}${tag("TitleText", b.title, I5)}${tag("Subtitle", b.subtitle, I5)}${I4}</TitleElement>\n${I3}</TitleDetail>\n`;
  (b.contributors ?? []).forEach((c, i) => {
    x += `${I3}<Contributor>\n${tag("SequenceNumber", i + 1, I4)}${tag("ContributorRole", c.role, I4)}${tag("PersonName", c.personName, I4)}${tag("BiographicalNote", c.biography, I4)}${I3}</Contributor>\n`;
  });
  x += tag("EditionNumber", b.editionNumber, I3);
  if (b.language) x += `${I3}<Language>\n${tag("LanguageRole", "01", I4)}${tag("LanguageCode", b.language, I4)}${I3}</Language>\n`;
  if (b.pageCount) x += `${I3}<Extent>\n${tag("ExtentType", "00", I4)}${tag("ExtentValue", b.pageCount, I4)}${tag("ExtentUnit", "03", I4)}${I3}</Extent>\n`;
  for (const s of b.subjects ?? []) {
    x += `${I3}<Subject>\n${tag("SubjectSchemeIdentifier", s.scheme, I4)}${tag("SubjectCode", s.code, I4)}${tag("SubjectHeadingText", s.heading, I4)}${I3}</Subject>\n`;
  }
  x += `${I2}</DescriptiveDetail>\n`;

  // CollateralDetail: the description as XHTML paragraphs.
  if (b.description) {
    const paras = b.description.split(/\n{2,}/).map((p) => `<p>${esc(p.replace(/\n/g, " ").trim())}</p>`).join("");
    x += `${I2}<CollateralDetail>\n${I3}<TextContent>\n${tag("TextType", "03", I4)}${tag("ContentAudience", "00", I4)}${I4}<Text textformat="06">${paras}</Text>\n${I3}</TextContent>\n${I2}</CollateralDetail>\n`;
  }

  // PublishingDetail
  if (b.publisherName || b.imprint || b.publicationDate) {
    x += `${I2}<PublishingDetail>\n`;
    if (b.imprint) x += `${I3}<Imprint>\n${tag("ImprintName", b.imprint, I4)}${I3}</Imprint>\n`;
    if (b.publisherName) x += `${I3}<Publisher>\n${tag("PublishingRole", "01", I4)}${tag("PublisherName", b.publisherName, I4)}${I3}</Publisher>\n`;
    x += tag("PublishingStatus", "04", I3);
    if (b.publicationDate) x += `${I3}<PublishingDate>\n${tag("PublishingDateRole", "01", I4)}${tag("Date", b.publicationDate, I4)}${I3}</PublishingDate>\n`;
    x += `${I2}</PublishingDetail>\n`;
  }

  // ProductSupply: the publisher as supplier, with the prices.
  if ((b.prices ?? []).length > 0) {
    x += `${I2}<ProductSupply>\n${I3}<SupplyDetail>\n${I4}<Supplier>\n${tag("SupplierRole", "01", I5)}${tag("SupplierName", b.publisherName || b.senderName || "OpenDesigner", I5)}${I4}</Supplier>\n${tag("ProductAvailability", "20", I4)}`;
    for (const p of b.prices ?? []) x += `${I4}<Price>\n${tag("PriceType", p.priceType, I5)}${tag("PriceAmount", p.amount, I5)}${tag("CurrencyCode", p.currency, I5)}${I4}</Price>\n`;
    x += `${I3}</SupplyDetail>\n${I2}</ProductSupply>\n`;
  }
  x += `${I1}</Product>\n</ONIXMessage>\n`;
  return x;
}

/** The names of the contributors with one of `roles`, in order (default: authors, A01). */
export const contributorNames = (b: BookLite | undefined, roles: readonly string[] = ["A01"]): string[] =>
  (b?.contributors ?? []).filter((c) => roles.includes(c.role)).map((c) => c.personName);
