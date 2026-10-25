package core

import (
	"fmt"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"regexp"
	"strings"
	"unicode"
)

// Book metadata (DocSettings.book): the bibliographic record of the document, read by the ONIX export and
// the EPUB / PDF metadata. The checks keep it safe to put in an XML message and plausible to a book trade
// system; they do not look values up in the ONIX code lists beyond their shape.

var (
	roleRe     = regexp.MustCompile(`^[A-Z][0-9]{2}$`)
	schemeRe   = regexp.MustCompile(`^[0-9]{2}$`)
	langRe     = regexp.MustCompile(`^[a-z]{3}$`)
	dateRe     = regexp.MustCompile(`^[0-9]{8}$`)
	digitsRe   = regexp.MustCompile(`^[0-9]{1,3}$`)
	amountRe   = regexp.MustCompile(`^[0-9]{1,8}(\.[0-9]{1,4})?$`)
	currencyRe = regexp.MustCompile(`^[A-Z]{3}$`)
	formRe     = regexp.MustCompile(`^[A-Z]{2}$`)
	emailRe    = regexp.MustCompile(`^[^@\s<>&]+@[^@\s<>&]+\.[^@\s<>&]+$`)
	codeRe     = regexp.MustCompile(`^[A-Za-z0-9.\-_ ]{1,20}$`)
)

// ValidISBN13 reports whether s is 13 digits with a correct check digit.
func ValidISBN13(s string) bool {
	if len(s) != 13 {
		return false
	}
	sum := 0
	for i, r := range s {
		if r < '0' || r > '9' {
			return false
		}
		w := 1
		if i%2 == 1 {
			w = 3
		}
		sum += int(r-'0') * w
	}
	return sum%10 == 0
}

// bookText: no control characters other than newlines, trimmed, at most max bytes.
func bookText(s string, max int) bool {
	if len(s) > max || strings.TrimSpace(s) != s {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) && r != '\n' {
			return false
		}
	}
	return true
}

func validateBook(b *opendesignerv1.BookMetadata) error {
	if b == nil {
		return nil
	}
	bad := func(what string) error { return fmt.Errorf("%w: book %s", ErrBadDocSettings, what) }
	if b.GetIsbn13() != "" && !ValidISBN13(b.GetIsbn13()) {
		return bad("isbn13")
	}
	for name, v := range map[string]string{"title": b.GetTitle(), "subtitle": b.GetSubtitle(), "series name": b.GetSeriesName(), "series number": b.GetSeriesNumber(),
		"publisher": b.GetPublisherName(), "imprint": b.GetImprint(), "sender name": b.GetSenderName()} {
		if !bookText(v, 300) || strings.Contains(v, "\n") {
			return bad(name)
		}
	}
	if !bookText(b.GetDescription(), 20000) {
		return bad("description")
	}
	if e := b.GetEditionNumber(); e != "" && !digitsRe.MatchString(e) {
		return bad("edition number")
	}
	if l := b.GetLanguage(); l != "" && !langRe.MatchString(l) {
		return bad("language")
	}
	if d := b.GetPublicationDate(); d != "" && (!dateRe.MatchString(d) || !validYMD(d)) {
		return bad("publication date")
	}
	if e := b.GetSenderEmail(); e != "" && (len(e) > 200 || !emailRe.MatchString(e)) {
		return bad("sender email")
	}
	if f := b.GetProductForm(); f != "" && !formRe.MatchString(f) {
		return bad("product form")
	}
	if b.GetPageCount() > 100000 {
		return bad("page count")
	}
	if len(b.GetContributors()) > 50 || len(b.GetSubjects()) > 50 || len(b.GetPrices()) > 50 {
		return bad("too many entries")
	}
	for _, c := range b.GetContributors() {
		if c == nil || !roleRe.MatchString(c.GetRole()) || c.GetPersonName() == "" || !bookText(c.GetPersonName(), 200) || strings.Contains(c.GetPersonName(), "\n") || !bookText(c.GetBiography(), 5000) {
			return bad("contributor")
		}
	}
	for _, s := range b.GetSubjects() {
		if s == nil || !schemeRe.MatchString(s.GetScheme()) || !codeRe.MatchString(s.GetCode()) || !bookText(s.GetHeading(), 200) || strings.Contains(s.GetHeading(), "\n") {
			return bad("subject")
		}
	}
	for _, p := range b.GetPrices() {
		if p == nil || !schemeRe.MatchString(p.GetPriceType()) || !amountRe.MatchString(p.GetAmount()) || !currencyRe.MatchString(p.GetCurrency()) {
			return bad("price")
		}
	}
	return nil
}

// validYMD reports whether a YYYYMMDD string is a real calendar date.
func validYMD(s string) bool {
	y, m, d := atoi(s[0:4]), atoi(s[4:6]), atoi(s[6:8])
	if y < 1000 || m < 1 || m > 12 || d < 1 {
		return false
	}
	days := [...]int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
	max := days[m-1]
	if m == 2 && (y%4 == 0 && y%100 != 0 || y%400 == 0) {
		max = 29
	}
	return d <= max
}

func atoi(s string) int {
	n := 0
	for _, r := range s {
		n = n*10 + int(r-'0')
	}
	return n
}
