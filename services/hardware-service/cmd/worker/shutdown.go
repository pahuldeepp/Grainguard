package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

const workerShutdownTimeout = 30 * time.Second

// runWorkers cancels sibling loops when one worker fails and waits for all
// loops to stop before the caller closes shared Kafka/MQTT/database clients.
func runWorkers(ctx context.Context, workers ...func(context.Context) error) error {
	if len(workers) == 0 {
		return nil
	}

	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	results := make(chan error, len(workers))
	var wg sync.WaitGroup
	for _, worker := range workers {
		wg.Add(1)
		go func(worker func(context.Context) error) {
			defer wg.Done()
			err := worker(workerCtx)
			if err == nil && workerCtx.Err() == nil {
				err = errors.New("worker loop stopped unexpectedly")
			}
			results <- err
		}(worker)
	}

	var workerErr error
	select {
	case <-ctx.Done():
	case workerErr = <-results:
	}
	cancel()
	drained := make(chan struct{})
	go func() {
		wg.Wait()
		close(drained)
	}()
	timer := time.NewTimer(workerShutdownTimeout)
	defer timer.Stop()
	select {
	case <-drained:
	case <-timer.C:
		return fmt.Errorf("worker loops did not stop within %s after cancellation", workerShutdownTimeout)
	}
	for len(results) > 0 {
		err := <-results
		if err != nil && !errors.Is(err, context.Canceled) && workerErr == nil {
			workerErr = err
		}
	}
	if workerErr != nil && !errors.Is(workerErr, context.Canceled) {
		return workerErr
	}

	if ctx.Err() != nil {
		return nil
	}
	if workerErr == nil {
		return fmt.Errorf("worker loop stopped without an error")
	}
	return workerErr
}
