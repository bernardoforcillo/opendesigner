package mcp

import (
	"context"
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/proto"
)

// verticalName is the name the tools report: an unset vertical is "product".
func verticalName(v string) string {
	if v == "" {
		return "product"
	}
	return v
}

type SetDocumentSettingsInput struct {
	Vertical          *string         `json:"vertical,omitempty" jsonschema:"publishing (books, magazines, reports: pages, masters, text frames, PDF/EPUB) | design (illustration, UI design, boards) | product (design and development together: flows, prototype, code). Shapes the editor, never limits what the document can hold"`
	BaselineIncrement *float64        `json:"baselineIncrement,omitempty" jsonschema:"distance between baseline grid lines, 0..1000; 0 = no grid"`
	BaselineStart     *float64        `json:"baselineStart,omitempty" jsonschema:"where the first baseline grid line sits, from the top of the page"`
	ColorMode         *string         `json:"colorMode,omitempty" jsonschema:"rgb (screens) | cmyk (print): swatches and colour fields work in CMYK and exports convert to it"`
	IccProfile        *string         `json:"iccProfile,omitempty" jsonschema:"the output condition the colours are meant for (FOGRA39, SWOP v2 ...), recorded as the PDF output intent; empty = none"`
	FacingPages       *bool           `json:"facingPages,omitempty" jsonschema:"pages are laid out as spreads (odd page numbers on the right): margins left/right become inside/outside"`
	Conditions        *[]ConditionIO  `json:"conditions,omitempty" jsonschema:"conditional text: the document's conditions, replacing the list. Text between [?name] and [/?] is hidden everywhere (canvas, exports, contents, index) while the condition name is not visible; a name not listed is visible"`
	TableStyles       *[]TableStyleIO `json:"tableStyles,omitempty" jsonschema:"table styles, replacing the list; give one to a table with apply_table_style"`
	Book              *BookIO         `json:"book,omitempty" jsonschema:"the document's bibliographic record (ONIX); replaces the whole record, an empty object clears it. Feeds the ONIX export in the editor and the EPUB / PDF metadata"`
}

// ConditionIO is a condition of conditional text.
type ConditionIO struct {
	Name    string `json:"name" jsonschema:"1..40 letters, digits, spaces, _ or -"`
	Visible bool   `json:"visible"`
}

// TableStyleIO is a named recipe for a table (object styles on the cells, text styles on their texts).
type TableStyleIO struct {
	Id                  string `json:"id"`
	Name                string `json:"name"`
	HeaderObjectStyleId string `json:"headerObjectStyleId,omitempty"`
	BodyObjectStyleId   string `json:"bodyObjectStyleId,omitempty"`
	AltObjectStyleId    string `json:"altObjectStyleId,omitempty" jsonschema:"every second body row"`
	HeaderTextStyleId   string `json:"headerTextStyleId,omitempty"`
	BodyTextStyleId     string `json:"bodyTextStyleId,omitempty"`
}

// BookIO is the book record, named after the ONIX 3.0 composites it feeds (docs/onix.md).
type BookIO struct {
	Isbn13          string          `json:"isbn13,omitempty" jsonschema:"13 digits with a valid check digit, no hyphens"`
	Title           string          `json:"title,omitempty"`
	Subtitle        string          `json:"subtitle,omitempty"`
	SeriesName      string          `json:"seriesName,omitempty"`
	SeriesNumber    string          `json:"seriesNumber,omitempty"`
	EditionNumber   string          `json:"editionNumber,omitempty"`
	Contributors    []ContributorIO `json:"contributors,omitempty"`
	Language        string          `json:"language,omitempty" jsonschema:"ISO 639-2/B, lower case: eng, ita, fre"`
	PublisherName   string          `json:"publisherName,omitempty"`
	Imprint         string          `json:"imprint,omitempty"`
	PublicationDate string          `json:"publicationDate,omitempty" jsonschema:"YYYYMMDD"`
	Description     string          `json:"description,omitempty" jsonschema:"plain text, a blank line between paragraphs"`
	Subjects        []SubjectIO     `json:"subjects,omitempty"`
	PageCount       uint32          `json:"pageCount,omitempty"`
	Prices          []PriceIO       `json:"prices,omitempty"`
	SenderName      string          `json:"senderName,omitempty" jsonschema:"ONIX message header; defaults to the publisher"`
	SenderEmail     string          `json:"senderEmail,omitempty"`
	ProductForm     string          `json:"productForm,omitempty" jsonschema:"ONIX list 150: ED digital (default), BC paperback, BB hardback"`
}

type ContributorIO struct {
	Role       string `json:"role" jsonschema:"ONIX list 17: A01 author, B01 editor, A12 illustrator, B06 translator"`
	PersonName string `json:"personName"`
	Biography  string `json:"biography,omitempty"`
}
type SubjectIO struct {
	Scheme  string `json:"scheme" jsonschema:"ONIX list 27: 10 BISAC, 12 BIC, 93 Thema, 20 keywords"`
	Code    string `json:"code"`
	Heading string `json:"heading,omitempty"`
}
type PriceIO struct {
	PriceType string `json:"priceType" jsonschema:"ONIX list 58: 02 recommended price including tax, 01 excluding tax"`
	Amount    string `json:"amount" jsonschema:"decimal, e.g. 9.99"`
	Currency  string `json:"currency" jsonschema:"ISO 4217, e.g. EUR"`
}

func (b *BookIO) toProto() *opendesignerv1.BookMetadata {
	if b == nil {
		return nil
	}
	out := &opendesignerv1.BookMetadata{
		Isbn13: b.Isbn13, Title: b.Title, Subtitle: b.Subtitle, SeriesName: b.SeriesName, SeriesNumber: b.SeriesNumber, EditionNumber: b.EditionNumber,
		Language: b.Language, PublisherName: b.PublisherName, Imprint: b.Imprint, PublicationDate: b.PublicationDate, Description: b.Description,
		PageCount: b.PageCount, SenderName: b.SenderName, SenderEmail: b.SenderEmail, ProductForm: b.ProductForm,
	}
	for _, c := range b.Contributors {
		out.Contributors = append(out.Contributors, &opendesignerv1.Contributor{Role: c.Role, PersonName: c.PersonName, Biography: c.Biography})
	}
	for _, x := range b.Subjects {
		out.Subjects = append(out.Subjects, &opendesignerv1.Subject{Scheme: x.Scheme, Code: x.Code, Heading: x.Heading})
	}
	for _, x := range b.Prices {
		out.Prices = append(out.Prices, &opendesignerv1.Price{PriceType: x.PriceType, Amount: x.Amount, Currency: x.Currency})
	}
	if proto.Equal(out, &opendesignerv1.BookMetadata{}) {
		return nil // an empty record is stored as nothing
	}
	return out
}

// SetDocumentSettings changes the vertical and / or the baseline grid; fields left out keep their value.
func (s *Session) SetDocumentSettings(ctx context.Context, in SetDocumentSettingsInput) (SeqOutput, error) {
	s.mu.Lock()
	next := &opendesignerv1.DocSettings{}
	if cur := s.doc.GetSettings(); cur != nil {
		next = proto.Clone(cur).(*opendesignerv1.DocSettings)
	}
	s.mu.Unlock()
	if in.Vertical != nil {
		v := *in.Vertical
		if v == "product" {
			v = "" // the default is stored as nothing
		}
		next.Vertical = v
	}
	if in.BaselineIncrement != nil {
		next.BaselineIncrement = *in.BaselineIncrement
	}
	if in.BaselineStart != nil {
		next.BaselineStart = *in.BaselineStart
	}
	if in.ColorMode != nil {
		m := *in.ColorMode
		if m == "rgb" {
			m = "" // the default is stored as nothing
		}
		next.ColorMode = m
	}
	if in.IccProfile != nil {
		next.IccProfile = *in.IccProfile
	}
	if in.FacingPages != nil {
		next.FacingPages = *in.FacingPages
	}
	if in.Book != nil {
		next.Book = in.Book.toProto()
	}
	if in.Conditions != nil {
		next.Conditions = nil
		for _, c := range *in.Conditions {
			next.Conditions = append(next.Conditions, &opendesignerv1.TextCondition{Name: c.Name, Visible: c.Visible})
		}
	}
	if in.TableStyles != nil {
		next.TableStyles = nil
		for _, t := range *in.TableStyles {
			next.TableStyles = append(next.TableStyles, &opendesignerv1.TableStyle{Id: t.Id, Name: t.Name, HeaderObjectStyleId: t.HeaderObjectStyleId,
				BodyObjectStyleId: t.BodyObjectStyleId, AltObjectStyleId: t.AltObjectStyleId, HeaderTextStyleId: t.HeaderTextStyleId, BodyTextStyleId: t.BodyTextStyleId})
		}
	}
	if err := core.ValidateDocSettings(next); err != nil {
		return SeqOutput{}, fmt.Errorf("set_document_settings: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetDocSettings{SetDocSettings: &opendesignerv1.SetDocSettings{Settings: next}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

func registerDocSettingsTools(srv *mcp.Server, s *Session) {
	addTool(srv, "set_document_settings", "Set the document's vertical (publishing | design | product: it shapes which modes, tools and menu entries the editor offers) and its baseline grid. Page size, margins, columns and bleed are set per page with create_page / update_page.", s.SetDocumentSettings)
}
