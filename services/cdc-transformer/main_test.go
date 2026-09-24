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
func TestBuildAppConfigurations(t *testing.T) {
	for _, values := range []map[string]string{
		{}, {"KAFKA_BROKERS": " , "}, {"KAFKA_BROKERS": "localhost:9092", "EVENT_SCHEMA_DIR": t.TempDir()},
		{"KAFKA_BROKERS": "localhost:9092", "OTEL_EXPORTER_OTLP_ENDPOINT": "file:///tmp/trace"},
	} {
		if a, err := buildApp(env(values)); err == nil {
			a.close()
			t.Fatal("bad config accepted")
		}
	}
	old := makeClient
	t.Cleanup(func() { makeClient = old })
	makeClient = func(...kgo.Opt) (kafkaClient, error) { return nil, errTest }
	if _, err := buildApp(env(map[string]string{"KAFKA_BROKERS": "localhost:9092"})); !errors.Is(err, errTest) {
		t.Fatal(err)
	}
	makeClient = func(...kgo.Opt) (kafkaClient, error) { return &fakeKafka{}, nil }
	a, err := buildApp(env(map[string]string{"KAFKA_BROKERS": "localhost:9092", "KAFKA_GROUP_ID": "custom", "EVENT_SCHEMA_DIR": schemaRoot}))
	if err != nil {
		t.Fatal(err)
	}
	a.close()
	if a.processor.ProcessTimeout >= time.Minute {
		t.Fatal("processing exceeds rebalance timeout")
	}
}

func TestTracingConfiguration(t *testing.T) {
	for _, endpoint := range []string{"%", "relative", "ftp://example.com"} {
		if p, err := initTracing(endpoint); err == nil {
			shutdownTracing(p)
			t.Fatal(endpoint)
		}
	}
	for _, endpoint := range []string{"", "http://127.0.0.1:4318", "https://example.com/otel"} {
		p, err := initTracing(endpoint)
		if err != nil {
			t.Fatal(err)
		}
		shutdownTracing(p)
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
		p.Metrics.ready.Store(tc.ready)
		pingFailed = tc.failed
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Code != tc.status {
			t.Fatal(tc, w.Code)
		}
	}
	p.Metrics.consumed.Add(4)
	p.Metrics.published.Add(2)
	p.Metrics.quarantined[reasonSchema].Add(1)
	p.Metrics.ignored["u"].Add(1)
	body := p.Metrics.render()
	for _, want := range []string{"cdc_consumed_total 4", "cdc_published_total 2", `cdc_quarantined_total{reason="schema_invalid"} 1`, `cdc_ignored_total{operation="u"} 1`} {
		if !strings.Contains(body, want) {
			t.Fatal(body)
		}
	}
	if strings.Contains(body, "tenant") || strings.Contains(body, "device") {
		t.Fatal("high-cardinality labels")
	}
}

func testApp(t *testing.T) *app {
	p := testProcessor(t)
	p.Source = sourceFunc(func(ctx context.Context) (Message, error) { <-ctx.Done(); return Message{}, ctx.Err() })
	return &app{processor: p, ping: func(ctx context.Context) error { return ctx.Err() }, close: func() { p.Metrics.ready.Store(false) }}
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
		addr := "127.0.0.1:18081"
		values := map[string]string{"HTTP_ADDR": addr}
		if useDefault {
			addr = "127.0.0.1:8081"
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

func TestRetentionFailureExitsNonZero(t *testing.T) {
	oldApp, oldListen, oldRun, oldExit := newApp, listen, runService, exit
	t.Cleanup(func() { newApp, listen, runService, exit = oldApp, oldListen, oldRun, oldExit })
	network := new(kfake.VirtualNetwork)
	listen = network.Listen
	a := testApp(t)
	a.processor.Source = &Kafka{client: &retentionKafka{}}
	newApp = func(func(string) string) (*app, error) { return a, nil }
	runService = func(ctx context.Context, _ func(string) string) error {
		err := run(ctx, env(nil))
		if !errors.Is(err, errCommittedOffsetLost) {
			t.Errorf("fatal error lost: %v", err)
		}
		return err
	}
	code := 0
	exit = func(c int) { code = c }
	main()
	if code != 1 || a.processor.Metrics.ready.Load() {
		t.Fatalf("exit=%d ready=%v", code, a.processor.Metrics.ready.Load())
	}
}
