package main

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthReadiness(t *testing.T) {
	cases := []struct {
		name, path string
		failure    bool
		want       int
	}{
		{"healthy liveness", "/healthz", false, 200},
		{"healthy readiness", "/readyz", false, 200},
		{"liveness survives database failure", "/healthz", true, 200},
		{"readiness reports database failure", "/readyz", true, 503},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := handler(func(ctx context.Context) error {
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("missing readiness timeout")
				}
				if tc.failure {
					return errors.New("secret database URL")
				}
				return nil
			})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", tc.path, nil))
			if w.Code != tc.want {
				t.Fatalf("got %d want %d", w.Code, tc.want)
			}
			if strings.Contains(w.Body.String(), "secret") {
				t.Fatal("leaked database error")
			}
		})
	}
}
