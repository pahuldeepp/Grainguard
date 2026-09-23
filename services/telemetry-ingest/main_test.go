package main

import (
	"context"
	"errors"
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
