package history

import (
	"errors"
	"testing"
	"time"
)

func TestTTLBounds(t *testing.T) {
	for _, tc := range []struct {
		input string
		valid bool
	}{
		{"1s", true}, {"175200h", true}, {"175200h1s", false}, {"500ms", false},
	} {
		t.Run(tc.input, func(t *testing.T) {
			got, err := TTL(func(string) string { return tc.input })
			if (err == nil) != tc.valid {
				t.Fatalf("TTL(%q) = %v, %v", tc.input, got, err)
			}
			if tc.valid && got < time.Second {
				t.Fatalf("valid TTL too small: %v", got)
			}
		})
	}
	if Rejected(nil) || Rejected(errors.New("unexpected")) {
		t.Fatal("unexpected row rejection")
	}
}
