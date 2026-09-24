package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

const (
	headerCorrelationID = "X-Correlation-Id"
	headerTraceparent   = "Traceparent"
)

type requestMetaKey struct{}

var traceparentPattern = regexp.MustCompile(`^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$`)

// RequestMetaFrom returns the correlation identity, or the zero value if the middleware did not run.
func RequestMetaFrom(ctx context.Context) RequestMeta {
	meta, _ := ctx.Value(requestMetaKey{}).(RequestMeta)
	return meta
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b) // never fails since Go 1.24
	return b
}

func newUUIDv4() string {
	b := randomBytes(16)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func newTraceparent() string {
	traceID, spanID := randomBytes(16), randomBytes(8)
	traceID[0] |= 1 // never all-zero
	spanID[0] |= 1
	return "00-" + hex.EncodeToString(traceID) + "-" + hex.EncodeToString(spanID) + "-01"
}

// sanitizeTraceparent keeps a well-formed, non-zero caller value and reduces flags to the sampled bit.
func sanitizeTraceparent(value string) (string, bool) {
	m := traceparentPattern.FindStringSubmatch(value)
	if m == nil || strings.Trim(m[1], "0") == "" || strings.Trim(m[2], "0") == "" {
		return "", false
	}
	flags, _ := strconv.ParseUint(m[3], 16, 8)
	suffix := "00"
	if flags&1 == 1 {
		suffix = "01"
	}
	return "00-" + m[1] + "-" + m[2] + "-" + suffix, true
}

func resolveTraceparent(r *http.Request) string {
	if tp, ok := ActiveTraceparent(r.Context()); ok {
		return tp
	}
	if tp, ok := sanitizeTraceparent(r.Header.Get(headerTraceparent)); ok {
		return tp
	}
	return newTraceparent()
}

// CorrelationMiddleware stores RequestMeta in the context and echoes the correlation id.
func CorrelationMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(headerCorrelationID)
		if !isUUID(id) {
			id = newUUIDv4()
		}
		meta := RequestMeta{CorrelationID: id, Traceparent: resolveTraceparent(r)}
		w.Header().Set(headerCorrelationID, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestMetaKey{}, meta)))
	})
}
