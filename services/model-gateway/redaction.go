package modelgateway

import (
	"golang.org/x/text/unicode/norm"
	"regexp"
	"strings"
	"unicode"
)

// Egress policy v1: never log matches or rewrite citation identifiers.
var redactionRules = []struct {
	kind    string
	pattern *regexp.Regexp
}{
	{"PRIVATE_KEY", regexp.MustCompile(`(?s)-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----.*?(?:-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|$)`)},
	{"SECRET", regexp.MustCompile(`(?i)\b(?:sk-(?:ant-)?|pcsk_)[a-z0-9_-]{16,}`)},
	{"SECRET", regexp.MustCompile(`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`)},
	{"SECRET", regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)},
	{"SECRET", regexp.MustCompile(`(?i)\b(?:password|passwd|api[_ -]?key|access[_ -]?token|client[_ -]?secret|authorization)\s*[:=]\s*["\x27]?(?:Bearer\s+)?[^\s"\x27,;]{4,}`)},
	{"SECRET", regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*`)},
	{"EMAIL", regexp.MustCompile(`(?i)\b[a-z0-9.!#$%&\x27*+/=?^_\x60{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b`)},
	{"PHONE", regexp.MustCompile(`\b[2-9][0-9]{2}[-. ][2-9][0-9]{2}[-. ][0-9]{4}\b`)},
}

func normalizePrivateText(text string) string {
	text = strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, norm.NFKC.String(text))
	return text
}

func redactText(text string) string {
	text = normalizePrivateText(text)
	for _, rule := range redactionRules {
		text = rule.pattern.ReplaceAllString(text, "[REDACTED_"+rule.kind+"]")
	}
	return text
}
func redactPassages(texts []string) []string {
	privateKey := false
	for _, text := range texts {
		if strings.Contains(normalizePrivateText(text), "PRIVATE KEY-----") {
			privateKey = true
		}
	}
	out := make([]string, len(texts))
	for i, text := range texts {
		if privateKey {
			out[i] = "[REDACTED_PRIVATE_KEY]"
		} else {
			out[i] = redactText(text)
		}
	}
	return out
}
