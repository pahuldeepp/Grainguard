package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

type fakePinger struct{ err error }

func (p fakePinger) Ping(context.Context) error { return p.err }

func TestRunRejectsMissingConfig(t *testing.T) {
	if err := run(context.Background(), func(string) string { return "" }); err == nil {
		t.Fatal("missing config accepted")
	}
	bad := map[string]string{"JOBS_DATABASE_URL": "::not a url", "RABBITMQ_URL": "amqp://x"}
	if err := run(context.Background(), func(k string) string { return bad[k] }); err == nil {
		t.Fatal("bad database URL accepted")
	}
}

func TestRunStartsAndStopsEveryComponent(t *testing.T) {
	env := map[string]string{
		"JOBS_DATABASE_URL": envOrSkip(t, "JOBS_DIRECT_URL"),
		"RABBITMQ_URL":      "amqp://nobody:nothing@127.0.0.1:1/",
		"KAFKA_BROKERS":     "127.0.0.1:1",
		"JOBS_HTTP_ADDR":    "127.0.0.1:0",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := run(ctx, func(k string) string { return env[k] }); err != nil {
		t.Fatal(err)
	}
	delete(env, "KAFKA_BROKERS")
	ctx2, cancel2 := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel2()
	if err := run(ctx2, func(k string) string { return env[k] }); err != nil {
		t.Fatal(err)
	}
}

func TestServeHTTPExposesHealthAndMetrics(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serveHTTP(addr, &Metrics{}, fakePinger{})(ctx) }()
	var resp *http.Response
	for i := 0; i < 50; i++ {
		if resp, err = http.Get("http://" + addr + "/healthz"); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("%v", err)
	}
	_ = resp.Body.Close()
	ready, err := http.Get("http://" + addr + "/readyz")
	if err != nil || ready.StatusCode != http.StatusOK {
		t.Fatalf("ready: %v", err)
	}
	_ = ready.Body.Close()
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := serveHTTP("256.0.0.1:bad", &Metrics{}, fakePinger{})(context.Background()); err == nil {
		t.Fatal("bad address accepted")
	}
}

func TestReadinessRequiresDatabasePing(t *testing.T) {
	rec := httptest.NewRecorder()
	readyHandler(fakePinger{err: errors.New("down")})(rec, httptest.NewRequest("GET", "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("ready status=%d", rec.Code)
	}
}

func TestRunAllStopsSiblingsWhenOneFails(t *testing.T) {
	boom := errors.New("boom")
	err := runAll(context.Background(), []component{
		func(context.Context) error { return boom },
		func(ctx context.Context) error { <-ctx.Done(); return nil },
	})
	if !errors.Is(err, boom) {
		t.Fatal(err)
	}
}

func TestMainExitsNonZeroOnFailure(t *testing.T) {
	t.Setenv("JOBS_DATABASE_URL", "")
	code := -1
	exit = func(c int) { code = c }
	defer func() { exit = os.Exit }()
	main()
	if code != 1 {
		t.Fatalf("exit %d", code)
	}
}

func TestKafkaSourcePollHonoursCancellation(t *testing.T) {
	src, err := newKafkaSource([]string{"127.0.0.1:1"}, "g", "t")
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if recs, err := src.Poll(ctx); len(recs) != 0 || err != nil {
		t.Fatalf("%v %v", recs, err)
	}
	if err := src.Commit(ctx, []Record{{Topic: "t"}}); err == nil {
		t.Log("commit on a cancelled context returned nil")
	}
	if _, err := newKafkaSource(nil, "", "t"); err == nil {
		t.Log("franz-go accepted an empty seed list")
	}
}
