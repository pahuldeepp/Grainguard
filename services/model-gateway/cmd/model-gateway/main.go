package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"greenguard.local/model-gateway"
)

const (
	providerTimeout     = 120 * time.Second
	httpWriteTimeout    = providerTimeout + 15*time.Second
	readinessWithdrawal = 5 * time.Second
	shutdownTimeout     = httpWriteTimeout
)

type accessFile struct {
	TokenHashes     map[string]modelgateway.Caller `json:"token_hashes"`
	EmbeddingModels map[string]string              `json:"embedding_models"`
	RerankerModels  map[string]string              `json:"reranker_models"`
	AnswerModels    map[string]string              `json:"answer_models"`
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	shutdownTracing, traceErr := modelgateway.InitTracing(context.Background(), os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	if traceErr != nil {
		return traceErr
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = shutdownTracing(ctx)
	}()
	path := os.Getenv("MODEL_GATEWAY_ACCESS_FILE")
	if path == "" {
		return errors.New("MODEL_GATEWAY_ACCESS_FILE is required")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return errors.New("cannot read model gateway access file")
	}
	var access accessFile
	if err := json.Unmarshal(data, &access); err != nil {
		return errors.New("model gateway access file is invalid")
	}
	var controls *modelgateway.ProductionControls
	if controlFile := os.Getenv("MODEL_GATEWAY_CONTROLS_FILE"); controlFile != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		var closeControls func()
		controls, closeControls, err = modelgateway.OpenControls(ctx, controlFile, secret("MODEL_GATEWAY_REDIS_URL_FILE"), secret("MODEL_GATEWAY_BUDGET_DSN_FILE"))
		cancel()
		if err != nil {
			return err
		}
		defer closeControls()
	} else if os.Getenv("MODEL_GATEWAY_ALLOW_UNCONTROLLED_LOCAL") != "true" {
		return errors.New("production controls required; explicit local test opt-out only")
	}
	server, err := modelgateway.New(modelgateway.Config{
		TokenHashes:     access.TokenHashes,
		Controls:        controls,
		EmbeddingModels: access.EmbeddingModels,
		RerankerModels:  access.RerankerModels,
		AnswerModels:    access.AnswerModels,
		VoyageURL:       os.Getenv("MODEL_GATEWAY_VOYAGE_URL"),
		VoyageKey:       secret("MODEL_GATEWAY_VOYAGE_KEY_FILE"),
		AnthropicURL:    os.Getenv("MODEL_GATEWAY_ANTHROPIC_URL"),
		AnthropicKey:    secret("MODEL_GATEWAY_ANTHROPIC_KEY_FILE"),
		ProviderURL:     os.Getenv("MODEL_GATEWAY_PROVIDER_URL"),
		ProviderKey:     os.Getenv("MODEL_GATEWAY_PROVIDER_KEY"), Timeout: providerTimeout,
	})
	if err != nil {
		return err
	}
	addr := os.Getenv("MODEL_GATEWAY_LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if controls == nil {
		host := strings.Split(addr, ":")[0]
		if host != "127.0.0.1" && host != "localhost" {
			return errors.New("uncontrolled gateway is restricted to loopback")
		}
	}
	httpServer := &http.Server{Addr: addr, Handler: server.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: httpWriteTimeout, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	log.Printf("model-gateway listening on %s", addr)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if controls != nil {
		go func() {
			ticker := time.NewTicker(60 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					seen := map[string]bool{}
					for _, caller := range access.TokenHashes {
						if seen[caller.TenantID] {
							continue
						}
						seen[caller.TenantID] = true
						reapCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
						err := controls.Budget.(*modelgateway.PostgresBudget).ReapTenant(reapCtx, caller.TenantID, 5*time.Minute)
						cancel()
						if err != nil {
							log.Print("budget reconciliation pending")
						}
					}
				}
			}
		}()
	}
	done := make(chan error, 1)
	go func() {
		<-ctx.Done()
		server.BeginDrain()
		time.Sleep(readinessWithdrawal) // Allow one readiness-probe period before closing listeners.
		done <- shutdownHTTP(httpServer, shutdownTimeout)
	}()
	err = httpServer.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return <-done
	}
	return err
}

func secret(variable string) string {
	path := os.Getenv(variable)
	if path == "" {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return ""
	}
	value, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(value))
}

// shutdownHTTP preserves in-flight requests up to the HTTP write deadline.
// If that bound expires, close connections before releasing dependency pools.
func shutdownHTTP(server *http.Server, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		_ = server.Close()
		return err
	}
	return nil
}
