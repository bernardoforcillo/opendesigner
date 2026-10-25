// Package onix builds an ONIX for Books 3.x message (reference tag names) from a document's book record
// (DocSettings.book). It is the server-side twin of web/src/export/onix.ts: the same bytes for the same record,
// checked against the fixtures in testdata/onix by both. See docs/onix.md for what is and is not covered.
package onix

import (
	"fmt"
	"strings"
	"time"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Namespace is the one ONIX 3.x keeps across its minor releases.
const Namespace = "http://ns.editeur.org/onix/3.0/reference"

// Problem is something a trade partner will miss, or that makes the message unusable.
type Problem struct {
	Severity string `json:"severity"` // error | warning
	Message  string `json:"message"`
}

// Problems lists what is missing from the record.
func Problems(b *opendesignerv1.BookMetadata) []Problem {
	var out []Problem
	add := func(sev, msg string) { out = append(out, Problem{sev, msg}) }
	if b.GetIsbn13() == "" {
		add("error", "No ISBN-13: the product cannot be identified.")
	}
	if b.GetTitle() == "" {
		add("error", "No title.")
	}
	if len(b.GetContributors()) == 0 {
		add("warning", "No contributor (author).")
	}
	if b.GetLanguage() == "" {
		add("warning", "No language.")
	}
	if b.GetPublisherName() == "" {
		add("warning", "No publisher.")
	}
	if b.GetPublicationDate() == "" {
		add("warning", "No publication date.")
	}
	if len(b.GetSubjects()) == 0 {
		add("warning", "No subject code (BISAC, Thema or BIC).")
	}
	if len(b.GetPrices()) == 0 {
		add("warning", "No price.")
	}
	if b.GetDescription() == "" {
		add("warning", "No description.")
	}
	return out
}

var escaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")

func tag(name, value, indent string) string {
	if value == "" {
		return ""
	}
	return fmt.Sprintf("%s<%s>%s</%s>\n", indent, name, escaper.Replace(value), name)
}

// DateTime is the ONIX default date-time format: 20260102T0304Z.
func DateTime(t time.Time) string { return t.UTC().Format("20060102T1504Z") }

// Build returns the message, or "" when the record has no ISBN or no title. release is "3.1" or "3.0".
func Build(b *opendesignerv1.BookMetadata, sent time.Time, release string) string {
	if b.GetIsbn13() == "" || b.GetTitle() == "" {
		return ""
	}
	if release == "" {
		release = "3.1"
	}
	const i1, i2, i3, i4, i5 = "  ", "    ", "      ", "        ", "          "
	form := b.GetProductForm()
	if form == "" {
		form = "ED"
	}
	var x strings.Builder
	w := func(s string) { x.WriteString(s) }

	w(fmt.Sprintf("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<ONIXMessage release=\"%s\" xmlns=\"%s\">\n", release, Namespace))
	sender := b.GetSenderName()
	if sender == "" {
		sender = b.GetPublisherName()
	}
	if sender == "" {
		sender = "OpenDesigner"
	}
	w(i1 + "<Header>\n" + i2 + "<Sender>\n" + tag("SenderName", sender, i3) + tag("EmailAddress", b.GetSenderEmail(), i3) + i2 + "</Sender>\n" + tag("SentDateTime", DateTime(sent), i2) + i1 + "</Header>\n")
	w(i1 + "<Product>\n")
	w(tag("RecordReference", "urn:isbn:"+b.GetIsbn13(), i2) + tag("NotificationType", "03", i2))
	w(i2 + "<ProductIdentifier>\n" + tag("ProductIDType", "15", i3) + tag("IDValue", b.GetIsbn13(), i3) + i2 + "</ProductIdentifier>\n")

	w(i2 + "<DescriptiveDetail>\n" + tag("ProductComposition", "00", i3) + tag("ProductForm", form, i3))
	if form == "ED" {
		w(tag("ProductFormDetail", "E101", i3))
	}
	if b.GetSeriesName() != "" {
		w(i3 + "<Collection>\n" + tag("CollectionType", "10", i4) + i4 + "<TitleDetail>\n" + tag("TitleType", "01", i5) + i5 + "<TitleElement>\n" +
			tag("TitleElementLevel", "02", i5+"  ") + tag("PartNumber", b.GetSeriesNumber(), i5+"  ") + tag("TitleText", b.GetSeriesName(), i5+"  ") + i5 + "</TitleElement>\n" + i4 + "</TitleDetail>\n" + i3 + "</Collection>\n")
	}
	w(i3 + "<TitleDetail>\n" + tag("TitleType", "01", i4) + i4 + "<TitleElement>\n" + tag("TitleElementLevel", "01", i5) + tag("TitleText", b.GetTitle(), i5) + tag("Subtitle", b.GetSubtitle(), i5) + i4 + "</TitleElement>\n" + i3 + "</TitleDetail>\n")
	for i, c := range b.GetContributors() {
		w(i3 + "<Contributor>\n" + tag("SequenceNumber", fmt.Sprint(i+1), i4) + tag("ContributorRole", c.GetRole(), i4) + tag("PersonName", c.GetPersonName(), i4) + tag("BiographicalNote", c.GetBiography(), i4) + i3 + "</Contributor>\n")
	}
	w(tag("EditionNumber", b.GetEditionNumber(), i3))
	if b.GetLanguage() != "" {
		w(i3 + "<Language>\n" + tag("LanguageRole", "01", i4) + tag("LanguageCode", b.GetLanguage(), i4) + i3 + "</Language>\n")
	}
	if b.GetPageCount() > 0 {
		w(i3 + "<Extent>\n" + tag("ExtentType", "00", i4) + tag("ExtentValue", fmt.Sprint(b.GetPageCount()), i4) + tag("ExtentUnit", "03", i4) + i3 + "</Extent>\n")
	}
	for _, s := range b.GetSubjects() {
		w(i3 + "<Subject>\n" + tag("SubjectSchemeIdentifier", s.GetScheme(), i4) + tag("SubjectCode", s.GetCode(), i4) + tag("SubjectHeadingText", s.GetHeading(), i4) + i3 + "</Subject>\n")
	}
	w(i2 + "</DescriptiveDetail>\n")

	if b.GetDescription() != "" {
		var paras []string
		for _, p := range splitParagraphs(b.GetDescription()) {
			paras = append(paras, "<p>"+escaper.Replace(strings.TrimSpace(strings.ReplaceAll(p, "\n", " ")))+"</p>")
		}
		w(i2 + "<CollateralDetail>\n" + i3 + "<TextContent>\n" + tag("TextType", "03", i4) + tag("ContentAudience", "00", i4) + i4 + "<Text textformat=\"06\">" + strings.Join(paras, "") + "</Text>\n" + i3 + "</TextContent>\n" + i2 + "</CollateralDetail>\n")
	}

	if b.GetPublisherName() != "" || b.GetImprint() != "" || b.GetPublicationDate() != "" {
		w(i2 + "<PublishingDetail>\n")
		if b.GetImprint() != "" {
			w(i3 + "<Imprint>\n" + tag("ImprintName", b.GetImprint(), i4) + i3 + "</Imprint>\n")
		}
		if b.GetPublisherName() != "" {
			w(i3 + "<Publisher>\n" + tag("PublishingRole", "01", i4) + tag("PublisherName", b.GetPublisherName(), i4) + i3 + "</Publisher>\n")
		}
		w(tag("PublishingStatus", "04", i3))
		if b.GetPublicationDate() != "" {
			w(i3 + "<PublishingDate>\n" + tag("PublishingDateRole", "01", i4) + tag("Date", b.GetPublicationDate(), i4) + i3 + "</PublishingDate>\n")
		}
		w(i2 + "</PublishingDetail>\n")
	}

	if len(b.GetPrices()) > 0 {
		supplier := b.GetPublisherName()
		if supplier == "" {
			supplier = b.GetSenderName()
		}
		if supplier == "" {
			supplier = "OpenDesigner"
		}
		w(i2 + "<ProductSupply>\n" + i3 + "<SupplyDetail>\n" + i4 + "<Supplier>\n" + tag("SupplierRole", "01", i5) + tag("SupplierName", supplier, i5) + i4 + "</Supplier>\n" + tag("ProductAvailability", "20", i4))
		for _, p := range b.GetPrices() {
			w(i4 + "<Price>\n" + tag("PriceType", p.GetPriceType(), i5) + tag("PriceAmount", p.GetAmount(), i5) + tag("CurrencyCode", p.GetCurrency(), i5) + i4 + "</Price>\n")
		}
		w(i3 + "</SupplyDetail>\n" + i2 + "</ProductSupply>\n")
	}
	w(i1 + "</Product>\n</ONIXMessage>\n")
	return x.String()
}

// splitParagraphs splits on runs of two or more newlines (the TS /\n{2,}/).
func splitParagraphs(s string) []string {
	var out []string
	start, i := 0, 0
	for i < len(s) {
		if s[i] == '\n' {
			j := i
			for j < len(s) && s[j] == '\n' {
				j++
			}
			if j-i >= 2 {
				out = append(out, s[start:i])
				start = j
			}
			i = j
			continue
		}
		i++
	}
	return append(out, s[start:])
}
