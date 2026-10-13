package modelgateway

import (
	"html"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// These targeted signatures are a defense in depth filter, not a proof that
// arbitrary natural-language instructions are safe. Never log the input.
var promptAttackPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^(?:ignore|disregard|forget|override|bypass).{0,60}(?:previous|prior|earlier|above|system|developer|safety|citation|all).{0,40}(?:instructions|prompts|rules|policy|policies|restrictions)`),
	regexp.MustCompile(`^(?:reveal|print|show|return|leak|exfiltrate|send|upload|disclose|export).{0,80}(?:systemprompt|developerprompt|hiddeninstructions|internalpolicy|developermessage|apikey|credentials|password|secrets|accesstoken)`),
	regexp.MustCompile(`^(?:execute|run|invoke|call).{0,40}(?:shellcommand|bash|powershell|terminalcommand|wget|pythonscript|browsertool|networktool|functioncall)`),
	regexp.MustCompile(`^(?:youarenow|actas|yournewroleis).{0,30}(?:system|developer|administrator|unrestricted|jailbroken)`),
}

// Preserve word boundaries before compacting the matched suffix. This prevents
// verbs embedded in agricultural words from turning into instructions.
var instructionVerb = verbPattern()
var curlDirective = regexp.MustCompile(`\b(?:run|execute|invoke|call)\s+(?:(?:the|this)\s+)?curl\s+(?:https?://|-)`)
var declaredRole = regexp.MustCompile(`\b(?:system|developer)\s+(?:role|message)\s*:`)

func verbPattern() *regexp.Regexp {
	verbs := []string{"ignore", "disregard", "forget", "override", "bypass", "reveal", "print", "show", "return", "leak", "exfiltrate", "send", "upload", "disclose", "export", "execute", "run", "invoke", "call", "youarenow", "actas", "yournewroleis"}
	patterns := make([]string, 0, len(verbs))
	for _, verb := range verbs {
		letters := strings.Split(verb, "")
		patterns = append(patterns, strings.Join(letters, `[\s\p{P}]*`))
	}
	return regexp.MustCompile(`\b(?:` + strings.Join(patterns, "|") + `)\b`)
}

var toolDirective = regexp.MustCompile(`\b(?:call|invoke|execute|run)\s+(?:(?:the|this|a)\s+)?(?:[a-z][a-z0-9_-]{0,40}\s+)?tool\b|\bfabricate\s+citations\b`)
var unicodeEscape = regexp.MustCompile(`\\u([0-9a-fA-F]{4})`)
var roleMarker = regexp.MustCompile(`(?m)(?:^|\n)\s*(?:system|developer|assistant)\s*:|<\s*/?\s*(?:system|developer|assistant)\s*>|\[\s*/?\s*(?:inst|system|developer|assistant)\s*\]|<\|(?:im_start|start_header_id|end_header_id)\|>`)

func promptInjection(text string) bool {
	// Decode common presentation obfuscations for detection only. Provider data is
	// never rewritten, so benign quotes and JSON boundaries remain intact.
	for i := 0; i < 2; i++ {
		text = html.UnescapeString(text)
		if decoded, err := url.PathUnescape(text); err == nil {
			text = decoded
		}
		text = unicodeEscape.ReplaceAllStringFunc(text, func(s string) string { n, _ := strconv.ParseInt(s[2:], 16, 32); return string(rune(n)) })
	}
	text = strings.ToLower(norm.NFKC.String(text))
	var normalized strings.Builder
	for _, r := range text {
		if unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Mn, r) {
			continue
		}
		// Common visually confusable Latin letters in role/override signatures.
		switch r {
		case 'а':
			r = 'a'
		case 'е':
			r = 'e'
		case 'о':
			r = 'o'
		case 'р':
			r = 'p'
		case 'с':
			r = 'c'
		case 'х':
			r = 'x'
		case 'і':
			r = 'i'
		case 'у':
			r = 'y'
		}
		normalized.WriteRune(r)
	}
	text = normalized.String()
	if roleMarker.MatchString(text) || toolDirective.MatchString(text) || curlDirective.MatchString(text) || declaredRole.MatchString(text) {
		return true
	}
	locations := instructionVerb.FindAllStringIndex(text, -1)
	var compact strings.Builder
	offsets := make([]int, len(locations))
	index := 0
	for position, r := range text {
		for index < len(locations) && locations[index][0] <= position {
			offsets[index] = compact.Len()
			index++
		}
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			compact.WriteRune(r)
		}
	}
	compacted := compact.String()
	for _, offset := range offsets {
		end := offset + 512
		if end > len(compacted) {
			end = len(compacted)
		}
		for _, pattern := range promptAttackPatterns {
			if pattern.MatchString(compacted[offset:end]) {
				return true
			}
		}
	}
	return false
}

func promptAllowed(w http.ResponseWriter, texts ...string) bool {
	for _, text := range texts {
		if promptInjection(text) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "prompt_injection_blocked"})
			return false
		}
	}
	// Detect directives split across request fields while preserving the original
	// provider payload. Handlers already bound field counts and input lengths.
	if len(texts) > 1 && promptInjection(strings.Join(texts, "\n")) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "prompt_injection_blocked"})
		return false
	}
	return true
}
