package history

import (
	"errors"
	"testing"
	"time"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
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

func TestClusterMetadataCacheModeDefaultsToFullAndCanBeOverridden(t *testing.T) {
	cfg, err := LoadConfig(func(key string) string {
		if key == "CASSANDRA_HOSTS" {
			return "127.0.0.1"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Cluster(cfg.Keyspace).Metadata.CacheMode; got != gocql.Full {
		t.Fatalf("default metadata cache mode = %v, want Full", got)
	}
	cfg.MetadataCacheMode = gocql.Disabled
	if got := cfg.Cluster(cfg.Keyspace).Metadata.CacheMode; got != gocql.Disabled {
		t.Fatalf("overridden metadata cache mode = %v, want Disabled", got)
	}
}
