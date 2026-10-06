package codegen

import (
	"strconv"
	"strings"
	"unicode"
)

// foldAccents maps the most common accented letters to ASCII: file and
// component names come from frame names, which in a document are often full of
// "Café", "Über" or "Señor".
var foldAccents = strings.NewReplacer(
	"à", "a", "á", "a", "â", "a", "ä", "a", "ã", "a", "å", "a",
	"è", "e", "é", "e", "ê", "e", "ë", "e",
	"ì", "i", "í", "i", "î", "i", "ï", "i",
	"ò", "o", "ó", "o", "ô", "o", "ö", "o", "õ", "o",
	"ù", "u", "ú", "u", "û", "u", "ü", "u",
	"ç", "c", "ñ", "n", "ß", "ss",
	"À", "A", "Á", "A", "Â", "A", "Ä", "A",
	"È", "E", "É", "E", "Ê", "E", "Ë", "E",
	"Ì", "I", "Í", "I", "Î", "I", "Ï", "I",
	"Ò", "O", "Ó", "O", "Ô", "O", "Ö", "O",
	"Ù", "U", "Ú", "U", "Û", "U", "Ü", "U",
	"Ç", "C", "Ñ", "N",
)

// words splits a name into alphanumeric ASCII words.
func words(name string) []string {
	name = foldAccents.Replace(name)
	return strings.FieldsFunc(name, func(r rune) bool {
		return r > unicode.MaxASCII || !(unicode.IsLetter(r) || unicode.IsDigit(r))
	})
}

// pascal: "Login screen" -> "LoginScreen". A name that does not start with a
// letter (or is empty) gets the "Screen" prefix, because an identifier cannot
// start with a digit.
func pascal(name string) string {
	var b strings.Builder
	for _, w := range words(name) {
		b.WriteString(strings.ToUpper(w[:1]) + w[1:])
	}
	s := b.String()
	if s == "" {
		return "Screen"
	}
	if s[0] >= '0' && s[0] <= '9' {
		return "Screen" + s
	}
	return s
}

// slug: "Login screen" -> "login-screen"; empty -> "screen".
func slug(name string) string {
	ws := words(name)
	for i, w := range ws {
		ws[i] = strings.ToLower(w)
	}
	s := strings.Join(ws, "-")
	if s == "" {
		return "screen"
	}
	return s
}

// classSlug: like slug but for CSS classes, where an identifier cannot start
// with a digit.
func classSlug(name string) string {
	s := slug(name)
	if s[0] >= '0' && s[0] <= '9' {
		return "n-" + s
	}
	return s
}

// dedupe: appends a numeric suffix until the name is free.
// `sep` separates the suffix ("-" for slugs, "" for PascalCase names).
func dedupe(used map[string]bool, base, sep string) string {
	name := base
	for i := 2; used[name]; i++ {
		name = base + sep + strconv.Itoa(i)
	}
	used[name] = true
	return name
}
