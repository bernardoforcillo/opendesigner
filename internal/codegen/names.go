package codegen

import (
	"strconv"
	"strings"
	"unicode"
)

// foldAccents riporta a ASCII le lettere accentate più comuni (italiano e
// dintorni): i nomi dei file e dei componenti nascono dai nomi dei frame, che
// in un documento italiano sono pieni di "Città", "Perché", "Più".
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

// words spezza un nome in parole ASCII alfanumeriche.
func words(name string) []string {
	name = foldAccents.Replace(name)
	return strings.FieldsFunc(name, func(r rune) bool {
		return r > unicode.MaxASCII || !(unicode.IsLetter(r) || unicode.IsDigit(r))
	})
}

// pascal: "Login screen" -> "LoginScreen". Un nome che non comincia con una
// lettera (o vuoto) riceve il prefisso "Screen", perché un identificatore non
// può cominciare con una cifra.
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

// slug: "Login screen" -> "login-screen"; vuoto -> "screen".
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

// classSlug: come slug ma per le classi CSS, dove un identificatore non può
// cominciare con una cifra.
func classSlug(name string) string {
	s := slug(name)
	if s[0] >= '0' && s[0] <= '9' {
		return "n-" + s
	}
	return s
}

// dedupe: aggiunge un suffisso numerico finché il nome non è libero.
// `sep` separa il suffisso ("-" per gli slug, "" per i nomi PascalCase).
func dedupe(used map[string]bool, base, sep string) string {
	name := base
	for i := 2; used[name]; i++ {
		name = base + sep + strconv.Itoa(i)
	}
	used[name] = true
	return name
}
