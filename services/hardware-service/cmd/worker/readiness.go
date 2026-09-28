package main

import (
	"context"
	"sync/atomic"
)

// workerReadiness combines external dependencies with actual consumer-group
// ownership. It never treats an open health listener or a reachable TCP port
// as evidence that this worker can process commands.
type workerReadiness struct {
	serving          atomic.Bool
	workersStarted   atomic.Int32
	consumerAssigned atomic.Bool
	ackSubscribed    atomic.Bool
	mqttConnected    func() bool
}

func (r *workerReadiness) ready() bool {
	return r != nil && r.serving.Load() && r.workersStarted.Load() == 3 && r.consumerAssigned.Load() &&
		r.ackSubscribed.Load() && r.mqttConnected != nil && r.mqttConnected()
}

func (r *workerReadiness) runWorker(worker func(context.Context) error) func(context.Context) error {
	return func(ctx context.Context) error {
		r.workersStarted.Add(1)
		defer r.workersStarted.Add(-1)
		return worker(ctx)
	}
}
