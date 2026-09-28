package saga

import (
	"strings"
	"testing"
)

const (
	testTraceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	testSpanID  = "00f067aa0ba902b7"
)

func TestSanitizeTraceparent(t *testing.T) {
	base := "00-" + testTraceID + "-" + testSpanID + "-"
	cases := map[string]struct {
		in, want string
		ok       bool
	}{
		"valid sampled":       {base + "01", base + "01", true},
		"unsampled preserved": {base + "00", base + "00", true},
		"other flags dropped": {base + "03", base + "01", true},
		"unsampled extra bit": {base + "02", base + "00", true},
		"missing":             {"", "", false},
		"version ff":          {"ff-" + testTraceID + "-" + testSpanID + "-01", "", false},
		"version 01":          {"01-" + testTraceID + "-" + testSpanID + "-01", "", false},
		"zero trace":          {"00-" + strings.Repeat("0", 32) + "-" + testSpanID + "-01", "", false},
		"zero span":           {"00-" + testTraceID + "-" + strings.Repeat("0", 16) + "-01", "", false},
		"uppercase":           {"00-" + strings.ToUpper(testTraceID) + "-" + testSpanID + "-01", "", false},
		"short":               {"00-abc-def-01", "", false},
		"trailing data":       {base + "01-extra", "", false},
	}
	for name, c := range cases {
		got, ok := SanitizeTraceparent(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: SanitizeTraceparent(%q) = %q,%v want %q,%v", name, c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestNewRootTraceparentIsRandomValidAndSampled(t *testing.T) {
	a, b := NewRootTraceparent(), NewRootTraceparent()
	if a == b {
		t.Fatal("two roots share an identity")
	}
	for _, tp := range []string{a, b} {
		if got, ok := SanitizeTraceparent(tp); !ok || got != tp || !strings.HasSuffix(tp, "-01") {
			t.Fatalf("root %q is not a valid sampled traceparent", tp)
		}
	}
}

func TestStartTraceOrigin(t *testing.T) {
	in := "00-" + testTraceID + "-" + testSpanID + "-00"
	if tp, origin := startTrace(in); tp != in || origin != TraceOriginPropagated {
		t.Fatalf("valid header: %q %q", tp, origin)
	}
	for _, bad := range []string{"", "00-" + strings.Repeat("0", 32) + "-" + testSpanID + "-01", "garbage"} {
		tp, origin := startTrace(bad)
		if origin != TraceOriginGenerated || tp == bad || strings.Contains(tp, strings.Repeat("0", 32)) {
			t.Fatalf("header %q: %q %q", bad, tp, origin)
		}
	}
}
