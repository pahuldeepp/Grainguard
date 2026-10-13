package main

import (
	"net"
	"strconv"
	"testing"
)

func TestEntitlementProjectorProbeTracksGroupAssignmentAndAllowsIdle(t *testing.T) {
	reserved, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := reserved.Addr().(*net.TCPAddr).Port
	if err := reserved.Close(); err != nil {
		t.Fatal(err)
	}
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	probe, err := newWorkerProbe(addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = probe.close(t.Context()) })

	if err := runWorkerProbe("/healthz", addr); err != nil {
		t.Fatalf("health should report process liveness: %v", err)
	}
	if err := runWorkerProbe("/readyz", addr); err == nil {
		t.Fatal("unassigned group should not be ready")
	}
	probe.setAssigned(true)
	if err := runWorkerProbe("/readyz", addr); err != nil {
		t.Fatalf("assigned idle worker should be ready: %v", err)
	}
	probe.setAssigned(false)
	if err := runWorkerProbe("/readyz", addr); err == nil {
		t.Fatal("worker should become unready after partition revocation")
	}
}

func TestEntitlementProjectorProbeMustBindLoopback(t *testing.T) {
	if _, err := newWorkerProbe("0.0.0.0:8090"); err == nil {
		t.Fatal("probe must not bind to a pod interface")
	}
	if err := runWorkerProbe("/unexpected", "127.0.0.1:8090"); err == nil {
		t.Fatal("probe command must reject unsupported paths")
	}
}
