package diagram

import (
	"fmt"
	"regexp"
	"strings"
)

// Mermaid erDiagram: entities with typed attributes and the relationships between them,
//
//	erDiagram
//	  CUSTOMER ||--o{ ORDER : places
//	  CUSTOMER {
//	    string name
//	    string email PK
//	  }
//
// An entity is drawn as a class (a name over its attribute rows) and a relationship as a line with the
// cardinality at each end -- "1", "0..1", "1..*", "0..*" -- instead of crow's-foot marks, which read the same
// and need no new shapes. A dotted line (`..`) is a non-identifying relationship; the label sits on the line.
// The layout is the class diagram's (renderClass), so the two kinds look alike.

var (
	reERHead = regexp.MustCompile(`(?i)^erDiagram\s*$`)
	erIdent  = `"?[A-Za-z_][\w-]*"?`
	reERRel  = regexp.MustCompile(`^(` + erIdent + `)\s+(\|\||\|o|\}\||\}o)(--|\.\.)(\|\||o\||\|\{|o\{)\s+(` + erIdent + `)\s*(?::\s*(.*))?$`)
	reEREnt  = regexp.MustCompile(`^(` + erIdent + `)(?:\s*\[\s*"?([^"\]]*)"?\s*\])?\s*(\{)?\s*$`)
	reERAttr = regexp.MustCompile(`^(\S+)\s+(\S+)(?:\s+((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*))?(?:\s+"([^"]*)")?\s*$`)
)

// erCard names a cardinality token as the multiplicity written beside the line.
func erCard(tok string) string {
	switch tok {
	case "||":
		return "1"
	case "|o", "o|":
		return "0..1"
	case "}|", "|{":
		return "1..*"
	case "}o", "o{":
		return "0..*"
	}
	return ""
}

func erName(raw string) string { return strings.Trim(raw, `"`) }

func parseER(src string) (*classDiagram, error) {
	cd := &classDiagram{Dir: DirTD}
	idx := map[string]int{}
	ensure := func(raw, label string) (*classDef, error) {
		id := erName(raw)
		if i, ok := idx[id]; ok {
			if label != "" {
				cd.Classes[i].Label = label
			}
			return &cd.Classes[i], nil
		}
		if len(cd.Classes) >= MaxNodes {
			return nil, fmt.Errorf("too many entities (maximum %d)", MaxNodes)
		}
		if label == "" {
			label = id
		}
		idx[id] = len(cd.Classes)
		cd.Classes = append(cd.Classes, classDef{ID: id, Label: label})
		return &cd.Classes[idx[id]], nil
	}
	sawHeader := false
	body := "" // the entity whose attribute block is open
	for _, raw := range strings.Split(strings.ReplaceAll(src, "\r", ""), "\n") {
		line := strings.TrimSpace(reComment.ReplaceAllString(raw, ""))
		if line == "" {
			continue
		}
		if reERHead.MatchString(line) {
			sawHeader = true
			continue
		}
		if body != "" {
			if line == "}" {
				body = ""
				continue
			}
			m := reERAttr.FindStringSubmatch(line)
			if m == nil {
				return nil, fmt.Errorf("unrecognized attribute in %s: %q", body, clip(line, 40))
			}
			row := m[1] + " " + m[2]
			if m[3] != "" {
				row += "  " + strings.ReplaceAll(m[3], " ", "")
			}
			if m[4] != "" {
				row += "  \"" + m[4] + "\""
			}
			c, _ := ensure(body, "")
			c.Attrs = append(c.Attrs, row)
			continue
		}
		if m := reERRel.FindStringSubmatch(line); m != nil {
			a, err := ensure(m[1], "")
			if err != nil {
				return nil, err
			}
			b, err := ensure(m[5], "")
			if err != nil {
				return nil, err
			}
			if len(cd.Rels) >= MaxEdges {
				return nil, fmt.Errorf("too many relationships (maximum %d)", MaxEdges)
			}
			cd.Rels = append(cd.Rels, classRel{
				A: a.ID, B: b.ID, Dashed: m[3] == "..", CardA: erCard(m[2]), CardB: erCard(m[4]),
				Label: unquote(strings.TrimSpace(m[6])), topIsA: true,
			})
			continue
		}
		if m := reEREnt.FindStringSubmatch(line); m != nil {
			c, err := ensure(m[1], strings.TrimSpace(m[2]))
			if err != nil {
				return nil, err
			}
			if m[3] == "{" {
				body = c.ID
			}
			continue
		}
		return nil, fmt.Errorf("unrecognized line: %q", clip(line, 40))
	}
	if body != "" {
		return nil, fmt.Errorf("the attributes of %s are not closed with \"}\"", body)
	}
	if len(cd.Classes) == 0 {
		if sawHeader {
			return nil, fmt.Errorf("the diagram has no entities")
		}
		return nil, fmt.Errorf("no entity found")
	}
	return cd, nil
}
