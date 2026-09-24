package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

const (
	obsGoodID = "3f2b8a52-1c1d-4e0a-9b7e-0a1b2c3d4e5f"
	obsV4     = `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
	obsTP     = `^00-[0-9a-f]{32}-[0-9a-f]{16}-01$`
)

func obsCorrelate(t *testing.T, headers map[string]string, mw func(http.Handler) http.Handler) (RequestMeta, string) {
	t.Helper()
	var got RequestMeta
	h := mw(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { got = RequestMetaFrom(r.Context()) }))
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return got, rec.Header().Get("X-Correlation-Id")
}

func TestCorrelationID(t *testing.T) {
	meta, hdr := obsCorrelate(t, map[string]string{"X-Correlation-Id": obsGoodID}, CorrelationMiddleware)
	if meta.CorrelationID != obsGoodID || hdr != obsGoodID {
		t.Fatalf("good id not kept: %q %q", meta.CorrelationID, hdr)
	}
	bad := []string{"", strings.ToUpper(obsGoodID), "00000000-0000-0000-0000-000000000000", "garbage"}
	for _, v := range bad {
		meta, hdr := obsCorrelate(t, map[string]string{"X-Correlation-Id": v}, CorrelationMiddleware)
		if !regexp.MustCompile(obsV4).MatchString(meta.CorrelationID) || meta.CorrelationID != hdr || meta.CorrelationID == v {
			t.Fatalf("%q -> %q / %q", v, meta.CorrelationID, hdr)
		}
	}
}

func TestCorrelationTraceparent(t *testing.T) {
	zero32, zero16 := strings.Repeat("0", 32), strings.Repeat("0", 16)
	cases := map[string]string{ // caller header -> expected ("" means freshly generated)
		"00-" + obsTraceID + "-" + obsSpanID + "-01": "00-" + obsTraceID + "-" + obsSpanID + "-01",
		"00-" + obsTraceID + "-" + obsSpanID + "-03": "00-" + obsTraceID + "-" + obsSpanID + "-01",
		"00-" + obsTraceID + "-" + obsSpanID + "-00": "00-" + obsTraceID + "-" + obsSpanID + "-00",
		"00-" + obsTraceID + "-" + obsSpanID + "-ff": "00-" + obsTraceID + "-" + obsSpanID + "-01",
		"00-" + zero32 + "-" + obsSpanID + "-01":     "",
		"00-" + obsTraceID + "-" + zero16 + "-01":    "",
		"01-" + obsTraceID + "-" + obsSpanID + "-01": "",
		"garbage": "",
		"":        "",
	}
	for in, want := range cases {
		meta, _ := obsCorrelate(t, map[string]string{"Traceparent": in}, CorrelationMiddleware)
		if want == "" {
			if !regexp.MustCompile(obsTP).MatchString(meta.Traceparent) || meta.Traceparent == in {
				t.Fatalf("%q -> %q", in, meta.Traceparent)
			}
		} else if meta.Traceparent != want {
			t.Fatalf("%q -> %q, want %q", in, meta.Traceparent, want)
		}
	}
}

func TestCorrelationPrefersActiveSpan(t *testing.T) {
	tr, _ := obsInit(t, 1)
	var got RequestMeta
	var active string
	h := tr.Middleware(CorrelationMiddleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		got = RequestMetaFrom(r.Context())
		active, _ = ActiveTraceparent(r.Context())
	})))
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Traceparent", "00-"+obsTraceID+"-"+obsSpanID+"-01")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if got.Traceparent != active || strings.HasSuffix(got.Traceparent, obsSpanID+"-01") {
		t.Fatalf("meta %q active %q", got.Traceparent, active)
	}
}

func TestRequestMetaFromWithoutMiddleware(t *testing.T) {
	if m := RequestMetaFrom(context.Background()); m != (RequestMeta{}) {
		t.Fatalf("got %+v", m)
	}
}
