package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"

	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"
)

func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}
func TestConfiguredWriterTarget(t *testing.T) {
	for _, tc := range []struct {
		schema, override, want string
		invalid                bool
	}{
		{"", "", consumerName, false},
		{"", "local-provisioning-projection-v1", "local-provisioning-projection-v1", false},
		{"read_v1", "", "greenguard.projection-builder.read_v1", false},
		{"read_v1", "custom", "", true},
		{"", "bad group", "", true},
		{"", strings.Repeat("a", 250), "", true},
	} {
		_, group, err := configuredWriterTarget(env(map[string]string{"PROJECTION_WRITE_SCHEMA": tc.schema, "KAFKA_GROUP_ID": tc.override}), "greenguard_read", "projection_app")
		if (err != nil) != tc.invalid || group != tc.want {
			t.Fatalf("%+v: group=%q err=%v", tc, group, err)
		}
	}
}
func TestBuildAppConfigurations(t *testing.T) {
	for _, values := range []map[string]string{
		{}, {"PROJECTION_HISTORY_HOT_WINDOW": "59m"}, {"PROJECTION_DATABASE_URL": "postgresql://nobody@127.0.0.1:1/none", "KAFKA_BROKERS": "localhost:9092", "EVENT_SCHEMA_DIR": t.TempDir()},
		{"KAFKA_BROKERS": "localhost:9092", "PROJECTION_DATABASE_URL": "not a url"},
	} {
		if a, err := buildApp(env(values)); err == nil {
			a.close()
			t.Fatal("bad config accepted")
		}
	}
	old := makeClient
	t.Cleanup(func() { makeClient = old })
	makeClient = func(...kgo.Opt) (kafkaClient, error) { return nil, errTest }
	if _, err := buildApp(env(map[string]string{"PROJECTION_DATABASE_URL": "postgresql://nobody@127.0.0.1:1/none", "KAFKA_BROKERS": "localhost:9092"})); !errors.Is(err, errTest) {
		t.Fatal(err)
	}
	makeClient = func(...kgo.Opt) (kafkaClient, error) { return &fakeKafka{}, nil }
	a, err := buildApp(env(map[string]string{"PROJECTION_DATABASE_URL": "postgresql://nobody@127.0.0.1:1/none", "KAFKA_BROKERS": "localhost:9092", "KAFKA_GROUP_ID": "custom", "EVENT_SCHEMA_DIR": "../../contracts/events"}))
	if err != nil {
		t.Fatal(err)
	}
	a.close()
	if a.processor.ProcessTimeout >= time.Minute {
		t.Fatal("processing exceeds rebalance timeout")
	}
}

func TestHealthReadinessMetrics(t *testing.T) {
	p := testProcessor(t)
	pingFailed := false
	a := &app{processor: p, ping: func(ctx context.Context) error {
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("missing timeout")
		}
		if pingFailed {
			return errTest
		}
		return nil
	}}
	h := newHandler(a)
	for _, tc := range []struct {
		method, path  string
		ready, failed bool
		status        int
	}{
		{"GET", "/healthz", true, false, 200}, {"GET", "/healthz", false, true, 200},
		{"GET", "/readyz", true, false, 200}, {"GET", "/readyz", true, true, 503}, {"GET", "/readyz", false, false, 503},
		{"GET", "/metrics", true, false, 200}, {"POST", "/metrics", true, false, 405},
	} {
		p.Ready.Store(tc.ready)
		pingFailed = tc.failed
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Code != tc.status {
			t.Fatal(tc, w.Code)
		}
	}

}

func testApp(t *testing.T) *app {
	p := testProcessor(t)
	p.Source = sourceFunc(func(ctx context.Context) (Message, error) { <-ctx.Done(); return Message{}, ctx.Err() })
	return &app{processor: p, ping: func(ctx context.Context) error { return ctx.Err() }, close: func() { p.Ready.Store(false) }}
}
func waitHTTP(t *testing.T, addr string, network *kfake.VirtualNetwork) {
	t.Helper()
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true, DialContext: network.DialContext}, Timeout: time.Second}
	defer client.CloseIdleConnections()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r, err := client.Get("http://" + addr + "/healthz")
		if err == nil {
			_ = r.Body.Close()
			if r.StatusCode == 200 {
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("HTTP server never started")
}
func TestRunLifecycle(t *testing.T) {
	old, oldListen := newApp, listen
	network := new(kfake.VirtualNetwork)
	listen = network.Listen
	t.Cleanup(func() { newApp = old; listen = oldListen })
	newApp = func(func(string) string) (*app, error) { return nil, errTest }
	if err := run(context.Background(), env(nil)); !errors.Is(err, errTest) {
		t.Fatal(err)
	}
	for _, useDefault := range []bool{false, true} {
		a := testApp(t)
		newApp = func(func(string) string) (*app, error) { return a, nil }
		addr := "127.0.0.1:18082"
		values := map[string]string{"HTTP_ADDR": addr}
		if useDefault {
			addr = "127.0.0.1:8082"
			delete(values, "HTTP_ADDR")
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- run(ctx, env(values)) }()
		waitHTTP(t, addr, network)
		cancel()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	newApp = func(func(string) string) (*app, error) { return testApp(t), nil }
	if err := run(context.Background(), env(map[string]string{"HTTP_ADDR": "bad:address:!"})); err == nil {
		t.Fatal("listen error missing")
	}
	a := testApp(t)
	a.processor.Source = sourceFunc(func(context.Context) (Message, error) { return Message{}, errTest })
	newApp = func(func(string) string) (*app, error) { return a, nil }
	if err := run(context.Background(), env(map[string]string{"HTTP_ADDR": "127.0.0.1:18082"})); !errors.Is(err, errTest) {
		t.Fatal(err)
	}
}

func TestMainExitSeams(t *testing.T) {
	oldRun, oldExit := runService, exit
	t.Cleanup(func() { runService = oldRun; exit = oldExit })
	for _, result := range []error{nil, http.ErrServerClosed, errTest} {
		code := 0
		exit = func(c int) { code = c }
		runService = func(context.Context, func(string) string) error { return result }
		main()
		if (code == 1) != (result == errTest) {
			t.Fatal(code, result)
		}
	}
}

func TestServeReportsHTTPFailure(t *testing.T) {
	network := new(kfake.VirtualNetwork)
	listener, err := network.Listen("tcp", "127.0.0.1:19000")
	if err != nil {
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	a := testApp(t)
	if err := serve(context.Background(), a, &http.Server{Handler: newHandler(a)}, listener); err == nil {
		t.Fatal("missing HTTP listener failure")
	}
}

type sourceFunc func(context.Context) (Message, error)

func (f sourceFunc) Next(ctx context.Context) (Message, error) { return f(ctx) }

func TestHistoryMetricExposed(t *testing.T) {
	a := testApp(t)
	a.historyOutOfWindow = func() uint64 { return 7 }
	w := httptest.NewRecorder()
	a.metrics(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !strings.Contains(w.Body.String(), "projection_history_out_of_window_total 7\n") {
		t.Fatal(w.Body.String())
	}
}
