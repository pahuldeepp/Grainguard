package modelgateway

import (
	"encoding/json"
	"io"
	"strings"
)

const outputAbstention = "I couldn't find sufficient evidence in the authorized source passages to answer that."

type answerOutput struct {
	Answer string   `json:"answer"`
	Cited  []string `json:"cited_chunk_ids"`
}

// Reject unknown/duplicate fields and trailing JSON. Standard Unmarshal alone
// accepts duplicate keys and unknown fields, which weakens the model contract.
func decodeAnswerOutput(content string) (answerOutput, bool) {
	var out answerOutput
	if len(content) > 65536 {
		return out, false
	}
	decoder := json.NewDecoder(strings.NewReader(content))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return out, false
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err = decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] {
			return out, false
		}
		seen[key] = true
		switch key {
		case "answer":
			err = decoder.Decode(&out.Answer)
		case "cited_chunk_ids":
			err = decoder.Decode(&out.Cited)
		default:
			return out, false
		}
		if err != nil {
			return out, false
		}
	}
	token, err = decoder.Token()
	if err != nil || token != json.Delim('}') || len(seen) != 2 {
		return out, false
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return out, false
	}
	return out, true
}
