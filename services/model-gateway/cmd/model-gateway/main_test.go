package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSecretFilesAreProtected(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret")
	t.Setenv("TEST_SECRET", "")
	if secret("TEST_SECRET") != "" {
		t.Fatal("missing path")
	}
	t.Setenv("TEST_SECRET", path)
	if secret("TEST_SECRET") != "" {
		t.Fatal("missing file")
	}
	if err := os.WriteFile(path, []byte("  synthetic  \n"), 0644); err != nil {
		t.Fatal(err)
	}
	if secret("TEST_SECRET") != "" {
		t.Fatal("public file accepted")
	}
	os.Chmod(path, 0600)
	if secret("TEST_SECRET") != "synthetic" {
		t.Fatal("private file rejected")
	}
	t.Setenv("TEST_SECRET", filepath.Dir(path))
	if secret("TEST_SECRET") != "" {
		t.Fatal("directory accepted")
	}
}
func TestStartupFailsClosedAndLocalOptOutIsBounded(t *testing.T) {
	t.Setenv("MODEL_GATEWAY_ACCESS_FILE", "")
	if run() == nil {
		t.Fatal("missing access accepted")
	}
	path := filepath.Join(t.TempDir(), "access")
	t.Setenv("MODEL_GATEWAY_ACCESS_FILE", path)
	if run() == nil {
		t.Fatal("missing file accepted")
	}
	os.WriteFile(path, []byte("invalid"), 0600)
	if run() == nil {
		t.Fatal("invalid JSON accepted")
	}
	digest := sha256.Sum256([]byte("synthetic"))
	access := map[string]any{"token_hashes": map[string]any{hex.EncodeToString(digest[:]): map[string]any{"tenant_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "scopes": []string{"knowledge:embed"}}}, "embedding_models": map[string]string{"embed": "embed"}, "reranker_models": map[string]string{"rerank": "rerank"}, "answer_models": map[string]string{"answer": "answer"}}
	raw, _ := json.Marshal(access)
	os.WriteFile(path, raw, 0600)
	t.Setenv("MODEL_GATEWAY_CONTROLS_FILE", "")
	t.Setenv("MODEL_GATEWAY_ALLOW_UNCONTROLLED_LOCAL", "")
	if run() == nil {
		t.Fatal("uncontrolled startup accepted")
	}
	t.Setenv("MODEL_GATEWAY_CONTROLS_FILE", "missing")
	if run() == nil {
		t.Fatal("missing controls accepted")
	}
	t.Setenv("MODEL_GATEWAY_CONTROLS_FILE", "")
	t.Setenv("MODEL_GATEWAY_ALLOW_UNCONTROLLED_LOCAL", "true")
	t.Setenv("MODEL_GATEWAY_PROVIDER_URL", "http://127.0.0.1:1/v1")
	t.Setenv("MODEL_GATEWAY_PROVIDER_KEY", "")
	if run() == nil {
		t.Fatal("missing provider key accepted")
	}
	t.Setenv("MODEL_GATEWAY_PROVIDER_KEY", "synthetic")
	t.Setenv("MODEL_GATEWAY_LISTEN_ADDR", ":8080")
	if run() == nil {
		t.Fatal("public uncontrolled listener accepted")
	}
	t.Setenv("MODEL_GATEWAY_LISTEN_ADDR", "127.0.0.1:bad")
	if run() == nil {
		t.Fatal("invalid listener accepted")
	}
}

func TestDrainBudgetCoversMaximumRequest(t *testing.T) {
	if providerTimeout != 120*time.Second || shutdownTimeout < httpWriteTimeout || httpWriteTimeout < providerTimeout+15*time.Second {
		t.Fatal("drain does not cover maximum request and response margin")
	}
	if readinessWithdrawal+shutdownTimeout > 150*time.Second-10*time.Second {
		t.Fatal("deployment grace has insufficient process exit margin")
	}
}

func TestShutdownCompletesInflightRequest(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	requestDone := make(chan error, 1)
	go func() {
		response, err := server.Client().Get(server.URL)
		if err == nil {
			_, err = io.Copy(io.Discard, response.Body)
			response.Body.Close()
		}
		requestDone <- err
	}()
	<-started
	drained := make(chan error, 1)
	go func() { drained <- shutdownHTTP(server.Config, 2*time.Second) }()
	select {
	case err := <-drained:
		close(release)
		t.Fatalf("premature shutdown: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	if err := <-requestDone; err != nil {
		t.Fatal(err)
	}
	if err := <-drained; err != nil {
		t.Fatal(err)
	}
}

func TestShutdownTimeoutClosesActiveConnections(t *testing.T) {
	started, cancelled := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(cancelled)
	}))
	defer server.Close()
	requestDone := make(chan error, 1)
	go func() {
		response, err := server.Client().Get(server.URL)
		if response != nil {
			response.Body.Close()
		}
		requestDone <- err
	}()
	<-started
	before := time.Now()
	if err := shutdownHTTP(server.Config, 20*time.Millisecond); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline, got %v", err)
	}
	if time.Since(before) > time.Second {
		t.Fatal("shutdown exceeded bound")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("active request not cancelled")
	}
	if err := <-requestDone; err == nil {
		t.Fatal("interrupted request succeeded")
	}
}
