package onix

import (
	"encoding/xml"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func full() *opendesignerv1.BookMetadata {
	return &opendesignerv1.BookMetadata{
		Isbn13: "9788804668237", Title: "Rose & <Name>", Subtitle: "A novel", SeriesName: "Classics", SeriesNumber: "3", EditionNumber: "2",
		Contributors: []*opendesignerv1.Contributor{{Role: "A01", PersonName: "Umberto Eco", Biography: "Italian writer"}, {Role: "B06", PersonName: "W. Weaver"}},
		Language:     "ita", PublisherName: "Bompiani", Imprint: "Tascabili", PublicationDate: "20240229", PageCount: 520,
		Description: "First paragraph.\nSame paragraph.\n\nSecond one.\n\n\nThird.",
		Subjects:    []*opendesignerv1.Subject{{Scheme: "10", Code: "FIC014000", Heading: "Historical"}, {Scheme: "93", Code: "FF"}},
		Prices:      []*opendesignerv1.Price{{PriceType: "02", Amount: "9.99", Currency: "EUR"}, {PriceType: "01", Amount: "8.18", Currency: "EUR"}},
		SenderName:  "Casa", SenderEmail: "onix@example.org",
	}
}

var sent = time.Date(2026, 1, 2, 3, 4, 59, 0, time.UTC)

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "onix", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The same bytes as web/src/export/onix.ts for the same record: the fixtures are checked from both sides.
func TestMatchesTheEditorsOutput(t *testing.T) {
	if got := Build(full(), sent, "3.1"); got != fixture(t, "full.3.1.xml") {
		t.Fatalf("full record differs from the fixture:\n%s", got)
	}
	min := &opendesignerv1.BookMetadata{Isbn13: "9788804668237", Title: "T", ProductForm: "BC"}
	if got := Build(min, sent, "3.0"); got != fixture(t, "minimal.3.0.xml") {
		t.Fatalf("minimal record differs from the fixture:\n%s", got)
	}
}

func TestIsWellFormedXML(t *testing.T) {
	d := xml.NewDecoder(strings.NewReader(Build(full(), sent, "3.1")))
	for {
		if _, err := d.Token(); err != nil {
			if err.Error() != "EOF" {
				t.Fatal(err)
			}
			return
		}
	}
}

func TestRefusesWithoutISBNOrTitle(t *testing.T) {
	if Build(&opendesignerv1.BookMetadata{Title: "T"}, sent, "3.1") != "" || Build(&opendesignerv1.BookMetadata{Isbn13: "9788804668237"}, sent, "3.1") != "" || Build(nil, sent, "3.1") != "" {
		t.Fatal("a record with no ISBN or no title has no message")
	}
}

func TestProblems(t *testing.T) {
	if p := Problems(&opendesignerv1.BookMetadata{}); len(p) != 9 || p[0].Severity != "error" || p[1].Severity != "error" {
		t.Fatalf("problems = %+v", p)
	}
	if p := Problems(full()); len(p) != 0 {
		t.Fatalf("a full record has no problems: %+v", p)
	}
}

func TestDefaultsToRelease31(t *testing.T) {
	if !strings.Contains(Build(full(), sent, ""), `release="3.1"`) {
		t.Fatal("default release")
	}
}
