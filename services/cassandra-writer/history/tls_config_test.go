package history

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCassandraSecurityConfigFailsClosed(t *testing.T) {
	base := map[string]string{"CASSANDRA_HOSTS": "cassandra", "CASSANDRA_USERNAME": "writer", "CASSANDRA_PASSWORD": "secret"}
	get := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if _, err := LoadConfig(get(map[string]string{"CASSANDRA_HOSTS": "cassandra", "CASSANDRA_USERNAME": "writer"})); err == nil {
		t.Fatal("partial password accepted")
	}
	if _, err := LoadConfig(get(map[string]string{"CASSANDRA_HOSTS": "cassandra", "CASSANDRA_REQUIRE_SECURE": "1"})); err == nil {
		t.Fatal("secure mode accepted plaintext anonymous CQL")
	}
	base["CASSANDRA_TLS_CA_FILE"] = "/missing/ca.pem"
	if _, err := LoadConfig(get(base)); err == nil || !strings.Contains(err.Error(), "supplied together") {
		t.Fatalf("partial TLS: %v", err)
	}
	base["CASSANDRA_TLS_SERVER_NAME"] = "cassandra.greenguard.svc"
	if _, err := LoadConfig(get(base)); err == nil || !strings.Contains(err.Error(), "read Cassandra TLS CA") {
		t.Fatalf("missing CA: %v", err)
	}
	path := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(path, []byte("not a PEM certificate"), 0600); err != nil {
		t.Fatal(err)
	}
	base["CASSANDRA_TLS_CA_FILE"] = path
	if _, err := LoadConfig(get(base)); err == nil || !strings.Contains(err.Error(), "no valid certificates") {
		t.Fatalf("invalid CA: %v", err)
	}
}
