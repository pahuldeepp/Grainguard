package modelgateway

import (
	"context"
	"crypto/tls"
	"os"
	"path/filepath"
	"testing"
)

func TestPostgresEndpointTLSPolicy(t *testing.T) {
	for _, host := range []string{"localhost", "127.0.0.1", "::1", "remote.example"} {
		for _, config := range []*tls.Config{nil, {InsecureSkipVerify: true}, {}} {
			want := host != "remote.example" || (config != nil && !config.InsecureSkipVerify)
			if got := postgresEndpointTLSAllowed(host, config); got != want {
				t.Fatalf("host %q TLS config %v allowed=%v, want %v", host, config, got, want)
			}
		}
	}
}

func TestOpenControlsRejectsRemoteFallbackWithLoopbackPrimary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "controls.json")
	if err := os.WriteFile(path, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	for _, dsn := range []string{
		"host=localhost,remote.example user=unused dbname=unused sslmode=disable",
		"host=127.0.0.1,remote.example user=unused dbname=unused sslmode=require",
		"host=::1,remote.example user=unused dbname=unused sslmode=prefer",
	} {
		controls, closeFn, err := OpenControls(context.Background(), path, "redis://127.0.0.1:6379", dsn)
		if err == nil || err.Error() != "Postgres TLS required outside loopback" {
			if closeFn != nil {
				closeFn()
			}
			t.Fatalf("expected remote fallback TLS rejection, controls=%v err=%v", controls, err)
		}
		if controls != nil || closeFn != nil {
			t.Fatal("unsafe controls must not be exposed")
		}
	}
}

func TestRedisPrivateCARejectsPlaintextAndInvalidCertificate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "controls.json")
	if err := os.WriteFile(path, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MODEL_GATEWAY_REDIS_CA_FILE", ca)
	for _, tc := range []struct{ url, want string }{
		{"redis://127.0.0.1:6379", "Redis CA requires verified TLS"},
		{"rediss://ai-redis.greenguard.svc.cluster.local:6379", "Redis CA certificate is invalid"},
	} {
		_, closeFn, err := OpenControls(context.Background(), path, tc.url, "")
		if closeFn != nil {
			closeFn()
		}
		if err == nil || err.Error() != tc.want {
			t.Fatalf("expected %s, got %v", tc.want, err)
		}
	}
}
