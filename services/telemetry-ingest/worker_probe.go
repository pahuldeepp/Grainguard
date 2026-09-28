package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

type workerProbe struct {
	assigned atomic.Bool
	server   *http.Server
}

func newWorkerProbe(addr string) (*workerProbe, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("invalid entitlement projector probe address: %w", err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return nil, errors.New("entitlement projector probe address must be loopback")
	}
	probe := &workerProbe{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !probe.assigned.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	probe.server = &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 2 * time.Second}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("listen for entitlement projector probes: %w", err)
	}
	go func() {
		if err := probe.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			// Liveness checks will fail because the listener is closed; callers
			// terminate the worker on consumer errors and probe startup failures.
		}
	}()
	return probe, nil
}

func (p *workerProbe) close(ctx context.Context) error {
	return p.server.Shutdown(ctx)
}

func (p *workerProbe) setAssigned(assigned bool) {
	p.assigned.Store(assigned)
}

func runWorkerProbe(path, addr string) error {
	if path != "/healthz" && path != "/readyz" {
		return errors.New("unsupported probe path")
	}
	u := url.URL{Scheme: "http", Host: addr, Path: path}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("probe returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func probeAddress(raw string) string {
	addr := strings.TrimSpace(raw)
	if addr == "" {
		return "127.0.0.1:8090"
	}
	return addr
}
