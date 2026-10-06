package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
)

type lifecycleBindingKafka struct {
	fakeBindingKafka
	message *BindingMessage
	started chan struct{}
}

func (f *lifecycleBindingKafka) PollRecords(ctx context.Context, _ int) kgo.Fetches {
	if f.message != nil {
		m := f.message
		f.message = nil
		return kgo.Fetches{{Topics: []kgo.FetchTopic{{Topic: m.Topic, Partitions: []kgo.FetchPartition{{Records: []*kgo.Record{{Topic: m.Topic, Key: m.Key, Value: m.Value}}}}}}}}
	}
	if f.started != nil {
		close(f.started)
		f.started = nil
	}
	<-ctx.Done()
	return kgo.Fetches{{Topics: []kgo.FetchTopic{{Partitions: []kgo.FetchPartition{{Err: ctx.Err()}}}}}}
}

func TestBindingRuntimeConfigLifecycleAndApply(t *testing.T) {
	app := App{Ping: func(context.Context) error { return nil }}
	worker, err := startBindingConsumer(context.Background(), nil, ingestConfig{}, cfgEnv(nil), &app)
	if err != nil || worker.done != nil {
		t.Fatal(err)
	}
	worker.close()
	config := map[string]string{"KAFKA_BROKERS": "broker", "EVENT_SCHEMA_DIR": t.TempDir()}
	if _, err := startBindingConsumer(context.Background(), nil, ingestConfig{}, cfgEnv(config), &app); err == nil {
		t.Fatal("missing schemas accepted")
	}
	delete(config, "EVENT_SCHEMA_DIR")
	old := createBindingKafka
	t.Cleanup(func() { createBindingKafka = old })
	createBindingKafka = func([]string, string) (*BindingKafka, error) { return nil, errBoom }
	if _, err := startBindingConsumer(context.Background(), nil, ingestConfig{}, cfgEnv(config), &app); !errors.Is(err, errBoom) {
		t.Fatal(err)
	}
	_, message := consumerFixture(t)
	fake := &lifecycleBindingKafka{message: &message}
	createBindingKafka = func(_ []string, group string) (*BindingKafka, error) {
		if group != bindingGroup {
			t.Fatal(group)
		}
		return &BindingKafka{client: fake}, nil
	}
	app.Ingestor = ingScripted(nil)
	worker, err = startBindingConsumer(context.Background(), failingDB{}, ingestConfig{BindingFeedMaxStale: time.Minute}, cfgEnv(config), &app)
	if err != nil {
		t.Fatal(err)
	}
	if err := <-worker.done; err == nil {
		t.Fatal("database failure did not stop worker")
	}
	if app.Ingestor.feed != app.Feed || app.Consumer.Ready.Load() {
		t.Fatal("runtime collaborators/readiness")
	}
	if err := app.Ping(context.Background()); !errors.Is(err, errBoom) {
		t.Fatal(err)
	}
	worker.close()
	if !fake.closed {
		t.Fatal("client not closed")
	}
}

func TestBindingRunWorkerFailureAndCancellation(t *testing.T) {
	oldApp, oldKafka, oldServe := newApp, createBindingKafka, serveHTTP
	t.Cleanup(func() { newApp, createBindingKafka, serveHTTP = oldApp, oldKafka, oldServe })
	for _, failure := range []bool{true, false} {
		ctx, cancel := context.WithCancel(context.Background())
		fake := &lifecycleBindingKafka{started: make(chan struct{})}
		started := fake.started
		createBindingKafka = func([]string, string) (*BindingKafka, error) { return &BindingKafka{client: fake}, nil }
		cleanup := false
		newApp = func(*pgxpool.Pool, ingestConfig) (App, func(), error) {
			return App{Ping: func(context.Context) error { return nil }}, func() { cleanup = true }, nil
		}
		serveHTTP = func(*http.Server) error {
			<-started
			if failure {
				return errBoom
			}
			cancel()
			return http.ErrServerClosed
		}
		err := run(ctx, cfgEnv(map[string]string{"TELEMETRY_DATABASE_URL": "postgres://u:p@localhost/db", "KAFKA_BROKERS": "broker"}))
		cancel()
		if failure && !errors.Is(err, errBoom) {
			t.Fatal(err)
		}
		if !failure && err != nil && !errors.Is(err, http.ErrServerClosed) {
			t.Fatal(err)
		}
		if !cleanup || !fake.closed {
			t.Fatal("shutdown leaked collaborators")
		}
	}
	// A worker error must stop HTTP as well. A synthetic server blocks until the
	// worker has returned; no real listener is required for this lifecycle test.
	createBindingKafka = func([]string, string) (*BindingKafka, error) { return nil, errBoom }
	if err := run(context.Background(), cfgEnv(map[string]string{"TELEMETRY_DATABASE_URL": "postgres://u:p@localhost/db", "KAFKA_BROKERS": "broker"})); !errors.Is(err, errBoom) {
		t.Fatal(err)
	}
}

func TestBindingHTTPReadinessMetricsAndRetryAfter(t *testing.T) {
	consumer, _ := consumerFixture(t)
	feed, _ := feedFixture()
	feed.DB = scriptDB{steps: []step{feedStep(6, &ingNow, &ingNow)}}
	app := App{Ping: func(context.Context) error { return nil }, Consumer: consumer, Feed: feed, Metrics: NewMetrics(), Recorder: NewRejectionRecorder(scriptDB{}, NewMetrics(), nil)}
	handler := newHandler(app)
	for _, ready := range []bool{false, true} {
		consumer.Ready.Store(ready)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		want := 503
		if ready {
			want = 200
		}
		if w.Code != want {
			t.Fatal(w.Code)
		}
	}
	old := ingNow.Add(-6 * time.Minute)
	feed.DB = scriptDB{steps: []step{feedStep(6, &old, &old)}}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("stale binding feed readiness = %d, want %d", w.Code, http.StatusServiceUnavailable)
	}
	feed.DB = failingDB{}
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "binding_feed_age_seconds +Inf") {
		t.Fatal(w.Body.String())
	}
	w = httptest.NewRecorder()
	app.refuse(w, httptest.NewRequest(http.MethodPost, "/", nil), Principal{}, "", newRejection(bindingFeedStale, 503, "stale"), nil)
	if w.Code != 503 || w.Header().Get(headerRetryAfter) != "5" {
		t.Fatal(w.Code, w.Header())
	}
	w = httptest.NewRecorder()
	App{}.metricsHandler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !strings.Contains(w.Body.String(), "# HELP http_server_requests_total") {
		t.Fatal(w.Body.String())
	}
}

func TestBindingRunStopsHTTPOnWorkerFailure(t *testing.T) {
	oldApp, oldWorker, oldServe := newApp, newBindingRuntime, serveHTTP
	t.Cleanup(func() { newApp, newBindingRuntime, serveHTTP = oldApp, oldWorker, oldServe })
	newApp = func(*pgxpool.Pool, ingestConfig) (App, func(), error) {
		return App{}, func() { t.Log("tracing released") }, nil
	}
	for _, cancelled := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		httpExited := make(chan struct{})
		serveHTTP = func(*http.Server) error { defer close(httpExited); <-ctx.Done(); return http.ErrServerClosed }
		newBindingRuntime = func(context.Context, TxStarter, ingestConfig, func(string) string, *App) (*bindingRuntime, error) {
			done := make(chan error, 1)
			done <- errBoom
			if cancelled {
				cancel()
			}
			return &bindingRuntime{done: done}, nil
		}
		err := run(ctx, cfgEnv(map[string]string{"TELEMETRY_DATABASE_URL": "postgres://u:p@localhost/db"}))
		cancel()
		<-httpExited
		if !cancelled && !errors.Is(err, errBoom) {
			t.Fatal(err)
		}
	}
}

func TestBindingWorkerResultDuringShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if bindingWorkerResult(ctx, errBoom) != nil {
		t.Fatal("expected shutdown reported as failure")
	}
	if !errors.Is(bindingWorkerResult(context.Background(), errBoom), errBoom) {
		t.Fatal("worker failure hidden")
	}
}

func TestBindingRuntimeUsesExplicitEnvironmentGroup(t *testing.T) {
	old := createBindingKafka
	t.Cleanup(func() { createBindingKafka = old })
	createBindingKafka = func(_ []string, group string) (*BindingKafka, error) {
		if group != "local-provisioning-test" {
			t.Fatalf("wrong environment group: %s", group)
		}
		return nil, errBoom
	}
	_, err := startBindingConsumer(context.Background(), nil, ingestConfig{}, cfgEnv(map[string]string{"KAFKA_BROKERS": "127.0.0.1:59092", "BINDING_KAFKA_GROUP": "local-provisioning-test"}), &App{})
	if !errors.Is(err, errBoom) {
		t.Fatal(err)
	}
}
