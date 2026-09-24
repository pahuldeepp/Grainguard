package common

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"
)

// ServeWorker couples HTTP readiness to a bounded background consumer. It
// cancels all work, drains the worker, then shuts down HTTP before returning.
func ServeWorker(parent context.Context, server *http.Server, listener net.Listener, worker func(context.Context) error, notReady func(), extra func(context.Context) <-chan error, shutdownTimeout time.Duration) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	httpDone, workerDone := make(chan error, 1), make(chan error, 1)
	var extraDone <-chan error
	if extra != nil {
		extraDone = extra(ctx)
	}
	go func() { httpDone <- server.Serve(listener) }()
	go func() { workerDone <- worker(ctx) }()
	var result error
	workerFinished := false
	select {
	case <-parent.Done():
		result = parent.Err()
	case result = <-httpDone:
	case result = <-workerDone:
		workerFinished = true
	case result = <-extraDone:
	}
	notReady()
	cancel()
	shutdown, stop := context.WithTimeout(context.Background(), shutdownTimeout)
	defer stop()
	shutdownErr := server.Shutdown(shutdown)
	if !workerFinished {
		select {
		case <-workerDone:
		case <-shutdown.Done():
			return errors.Join(result, shutdownErr, fmt.Errorf("worker did not stop before shutdown deadline: %w", shutdown.Err()))
		}
	}
	if parent.Err() != nil && errors.Is(result, context.Canceled) {
		result = nil
	}
	return errors.Join(result, shutdownErr)
}
