package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
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
			h := newHandler(App{Ping: func(ctx context.Context) error {
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("missing readiness timeout")
				}
				if tc.failure {
					return errors.New("secret database URL")
				}
				return nil
			}})
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

func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().String()
}

func TestRunRejectsBadConfiguration(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"missing database URL", map[string]string{}, "TELEMETRY_DATABASE_URL is required"},
		{"unparseable database URL", map[string]string{"TELEMETRY_DATABASE_URL": "postgres://user:secret@host:notaport/db"}, "invalid database configuration"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := run(context.Background(), env(tc.env))
			if err == nil || err.Error() != tc.want {
				t.Fatalf("got %v want %q", err, tc.want)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Fatal("leaked database credentials")
			}
		})
	}
}

func TestRunServesAndShutsDownGracefully(t *testing.T) {
	addr := freeAddr(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, env(map[string]string{
			"TELEMETRY_DATABASE_URL": "postgres://u:p@127.0.0.1:1/db?connect_timeout=1",
			"HTTP_ADDR":              addr,
		}))
	}()
	waitFor(t, "http://"+addr+"/healthz", 200)
	waitFor(t, "http://"+addr+"/readyz", 503)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("graceful shutdown returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown timed out")
	}
}

func TestRunReportsListenFailure(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	err = run(context.Background(), env(map[string]string{
		"TELEMETRY_DATABASE_URL": "postgres://u:p@127.0.0.1:1/db",
		"HTTP_ADDR":              l.Addr().String(),
	}))
	if err == nil {
		t.Fatal("expected listen failure")
	}
}

func TestRunUsesDefaultAddress(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:8080")
	if err != nil {
		t.Skip("default port in use")
	}
	l.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, env(map[string]string{"TELEMETRY_DATABASE_URL": "postgres://u:p@127.0.0.1:1/db"}))
	}()
	waitFor(t, "http://127.0.0.1:8080/healthz", 200)
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestMainExitsNonZeroOnFailure(t *testing.T) {
	t.Setenv("TELEMETRY_DATABASE_URL", "")
	code := -1
	exit = func(c int) { code = c }
	defer func() { exit = os.Exit }()
	main()
	if code != 1 {
		t.Fatalf("exit code %d", code)
	}
}

func TestMainShutsDownOnSIGTERM(t *testing.T) {
	addr := freeAddr(t)
	t.Setenv("TELEMETRY_DATABASE_URL", "postgres://u:p@127.0.0.1:1/db")
	t.Setenv("HTTP_ADDR", addr)
	// A sourced .env may set the control-plane variables; the service rejects a
	// half configuration, so this test must not inherit either one.
	t.Setenv("CONTROL_LOOKUP_TOKEN", "")
	t.Setenv("CONTROL_PLANE_URL", "")
	guard := make(chan os.Signal, 1)
	signal.Notify(guard, syscall.SIGTERM)
	defer signal.Stop(guard)
	exit = func(c int) { t.Errorf("unexpected exit %d", c) }
	defer func() { exit = os.Exit }()
	done := make(chan struct{})
	go func() { main(); close(done) }()
	waitFor(t, "http://"+addr+"/healthz", 200)
	if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("main did not stop on SIGTERM")
	}
}

var client = &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}

func waitFor(t *testing.T, url string, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == want {
				return
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("%s never returned %d", url, want)
}

func TestRunReportsPoolInitializationFailure(t *testing.T) {
	newPool = func(context.Context, *pgxpool.Config) (*pgxpool.Pool, error) {
		return nil, errors.New("dial secret-host")
	}
	defer func() { newPool = pgxpool.NewWithConfig }()
	err := run(context.Background(), env(map[string]string{"TELEMETRY_DATABASE_URL": "postgres://u:p@127.0.0.1:1/db"}))
	if err == nil || err.Error() != "database pool initialization failed" {
		t.Fatalf("got %v", err)
	}
}

func TestRunReportsInvalidIngestConfigurationBeforeConnecting(t *testing.T) {
	err := run(context.Background(), env(map[string]string{
		"TELEMETRY_DATABASE_URL": "postgres://u:p@127.0.0.1:1/db",
		"AUTH_ISSUER":            "https://idp.example",
	}))
	if err == nil || !strings.Contains(err.Error(), "must be set together") {
		t.Fatalf("got %v", err)
	}
}

func TestRunServesTheIngestEndpointEndToEnd(t *testing.T) {
	originalPool := newPool
	newPool = func(ctx context.Context, cfg *pgxpool.Config) (*pgxpool.Pool, error) {
		configureFixturePlacement(t, cfg)
		return pgxpool.NewWithConfig(ctx, cfg)
	}
	defer func() { newPool = originalPool }()
	issuer := newTestIssuer(t)
	tenant, device := randomUUID(), randomUUID()
	mustApply(t, pooled(t, 2), eventSpec{kind: "device.registered", tenant: tenant, device: device, version: 1}, BindingApplied)
	addr := freeAddr(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, env(map[string]string{
			"TELEMETRY_DATABASE_URL":      os.Getenv("TELEMETRY_DATABASE_URL"),
			"HTTP_ADDR":                   addr,
			"AUTH_ISSUER":                 issuer.Issuer,
			"AUTH_AUDIENCE":               issuer.Audience,
			"AUTH_JWKS_URL":               issuer.URL,
			"OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:1",
		}))
	}()
	waitFor(t, "http://"+addr+"/healthz", 200)
	body := fmt.Sprintf(`{"source_message_id":"run-1","observed_at":%q,"temperature_c":19.5}`,
		time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano))
	req, _ := http.NewRequest("POST", "http://"+addr+"/v1/devices/"+device+"/readings", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+issuer.sign(map[string]any{"tenant_id": tenant, "sub": "op-1", "roles": []string{RoleOperator}}))
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("ingest through run(): %d", resp.StatusCode)
	}
	waitFor(t, "http://"+addr+"/metrics", 200)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("graceful shutdown returned %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("shutdown timed out")
	}
}

func TestBuildAppReportsSetupFailures(t *testing.T) {
	pool := pooled(t, 1)
	if _, _, err := buildApp(pool, ingestConfig{OTLPEndpoint: "ftp://collector"}); err == nil {
		t.Fatal("an invalid OTLP endpoint must fail")
	}
	// A verifier that cannot be built must release the tracer that was already started.
	if _, _, err := buildApp(pool, ingestConfig{OTLPEndpoint: "http://127.0.0.1:1", Auth: &AuthConfig{}}); err == nil {
		t.Fatal("an unusable auth configuration must fail")
	}
	app, shutdown, err := buildApp(pool, ingestConfig{})
	if err != nil || app.Verifier != nil || app.Tracing != nil {
		t.Fatalf("without auth only the probes are served: %+v %v", app, err)
	}
	shutdown()
}

func TestRunReportsAppSetupFailures(t *testing.T) {
	newApp = func(*pgxpool.Pool, ingestConfig) (App, func(), error) { return App{}, nil, errors.New("setup failed") }
	defer func() { newApp = buildApp }()
	err := run(context.Background(), env(map[string]string{"TELEMETRY_DATABASE_URL": "postgres://u:p@127.0.0.1:1/db"}))
	if err == nil || err.Error() != "setup failed" {
		t.Fatalf("got %v", err)
	}
}
