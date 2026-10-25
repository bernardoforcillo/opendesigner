import { describe, it, expect } from "vitest";
import { buildOnix, contributorNames, onixDateTime, onixProblems } from "./onix";
import type { BookLite } from "../store/types";

const book: BookLite = {
  isbn13: "9788804668237", title: "Rose & <Name>", subtitle: "A novel", seriesName: "Classics", seriesNumber: "3", editionNumber: "2",
  contributors: [{ role: "A01", personName: "Umberto Eco", biography: "Italian writer" }, { role: "B06", personName: "W. Weaver" }],
  language: "ita", publisherName: "Bompiani", imprint: "Tascabili", publicationDate: "20240229", pageCount: 520,
  description: "First paragraph.\nSame paragraph.\n\nSecond one.",
  subjects: [{ scheme: "10", code: "FIC014000", heading: "Historical" }],
  prices: [{ priceType: "02", amount: "9.99", currency: "EUR" }], senderName: "Casa", senderEmail: "onix@example.org",
};
const sent = new Date(Date.UTC(2026, 0, 2, 3, 4, 59));

describe("buildOnix", () => {
  it("is well-formed XML in the ONIX 3.0 reference namespace", () => {
    const xml = buildOnix(book, sent)!;
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    const root = doc.documentElement;
    expect(root.localName).toBe("ONIXMessage");
    expect(root.getAttribute("release")).toBe("3.1");
    expect(root.namespaceURI).toBe("http://ns.editeur.org/onix/3.0/reference");
  });

  it("can write release 3.0, with the same content", () => {
    const a = buildOnix(book, sent, "3.0")!, b = buildOnix(book, sent)!;
    expect(a).toContain('release="3.0"');
    expect(a.replace('release="3.0"', 'release="3.1"')).toBe(b);
  });

  it("writes header, identifier and title, escaping markup", () => {
    const xml = buildOnix(book, sent)!;
    expect(xml).toContain("<SentDateTime>20260102T0304Z</SentDateTime>");
    expect(xml).toContain("<SenderName>Casa</SenderName>");
    expect(xml).toMatch(/<ProductIDType>15<\/ProductIDType>\s*<IDValue>9788804668237<\/IDValue>/);
    expect(xml).toContain("<TitleText>Rose &amp; &lt;Name&gt;</TitleText>");
    expect(xml).toContain("<Subtitle>A novel</Subtitle>");
    expect(xml).toContain("<NotificationType>03</NotificationType>");
  });

  it("keeps the schema's element order inside each composite", () => {
    const doc = new DOMParser().parseFromString(buildOnix(book, sent)!, "application/xml");
    const names = (el: Element) => [...el.children].map((c) => c.localName);
    const product = doc.getElementsByTagName("Product")[0]!;
    expect(names(product)).toEqual(["RecordReference", "NotificationType", "ProductIdentifier", "DescriptiveDetail", "CollateralDetail", "PublishingDetail", "ProductSupply"]);
    expect(names(doc.getElementsByTagName("DescriptiveDetail")[0]!)).toEqual([
      "ProductComposition", "ProductForm", "ProductFormDetail", "Collection", "TitleDetail", "Contributor", "Contributor", "EditionNumber", "Language", "Extent", "Subject",
    ]);
    expect(names(doc.getElementsByTagName("Contributor")[0]!)).toEqual(["SequenceNumber", "ContributorRole", "PersonName", "BiographicalNote"]);
    expect(names(doc.getElementsByTagName("PublishingDetail")[0]!)).toEqual(["Imprint", "Publisher", "PublishingStatus", "PublishingDate"]);
    expect(names(doc.getElementsByTagName("SupplyDetail")[0]!)).toEqual(["Supplier", "ProductAvailability", "Price"]);
  });

  it("numbers contributors, sets series, extent, subject, price and the XHTML description", () => {
    const xml = buildOnix(book, sent)!;
    expect(xml).toContain("<SequenceNumber>2</SequenceNumber>");
    expect(xml).toContain("<CollectionType>10</CollectionType>");
    expect(xml).toContain("<PartNumber>3</PartNumber>");
    expect(xml).toContain("<ExtentValue>520</ExtentValue>");
    expect(xml).toContain("<SubjectSchemeIdentifier>10</SubjectSchemeIdentifier>");
    expect(xml).toContain("<PriceAmount>9.99</PriceAmount>");
    expect(xml).toContain('<Text textformat="06"><p>First paragraph. Same paragraph.</p><p>Second one.</p></Text>');
    expect(xml).toContain("<ProductFormDetail>E101</ProductFormDetail>");
  });

  it("a print edition has no EPUB form detail and a record without extras stays valid", () => {
    const xml = buildOnix({ isbn13: "9788804668237", title: "T", productForm: "BC" }, sent)!;
    expect(xml).not.toContain("ProductFormDetail");
    expect(xml).not.toContain("<ProductSupply>");
    expect(new DOMParser().parseFromString(xml, "application/xml").getElementsByTagName("parsererror")).toHaveLength(0);
  });

  it("refuses a record with no ISBN or no title", () => {
    expect(buildOnix({ title: "T" }, sent)).toBeNull();
    expect(buildOnix({ isbn13: "9788804668237" }, sent)).toBeNull();
  });
});

describe("onixProblems", () => {
  it("lists what is missing, errors first-class", () => {
    const p = onixProblems({});
    expect(p.filter((x) => x.severity === "error")).toHaveLength(2);
    expect(p.map((x) => x.message)).toContain("No price.");
    expect(onixProblems(book)).toEqual([]);
  });
});

describe("helpers", () => {
  it("formats the date-time and picks contributors by role", () => {
    expect(onixDateTime(sent)).toBe("20260102T0304Z");
    expect(contributorNames(book)).toEqual(["Umberto Eco"]);
    expect(contributorNames(book, ["A01", "B06"])).toEqual(["Umberto Eco", "W. Weaver"]);
    expect(contributorNames(undefined)).toEqual([]);
  });
});
