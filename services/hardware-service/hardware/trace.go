package hardware

import (
	"crypto/sha256"
	"encoding/json"
	"regexp"
	"strings"
)

var traceparentPattern = regexp.MustCompile(`^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$`)

// commandTrace returns the saga's W3C context carried by the command (ADR-0004,
// Saga section): version 00, non-zero IDs, sampled bit kept, other flags
// dropped. An invalid or absent value yields "" and is never replaced by an
// invented trace.
func commandTrace(c Command) string {
	m := traceparentPattern.FindStringSubmatch(c.Traceparent)
	if m == nil || strings.Trim(m[1], "0") == "" || strings.Trim(m[2], "0") == "" {
		return ""
	}
	flags := "00"
	if strings.ContainsAny(m[3][1:], "13579bdf") {
		flags = "01"
	}
	return "00-" + m[1] + "-" + m[2] + "-" + flags
}

// requestHash is the command identity. Trace context is excluded so a receipt
// written before trace propagation still matches its redelivered command.
func requestHash(c Command) [32]byte {
	c.Traceparent = ""
	data, _ := json.Marshal(c)
	return sha256.Sum256(data)
}
