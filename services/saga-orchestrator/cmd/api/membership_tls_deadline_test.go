package main

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestMembershipRedisTLSHandshakeHonorsContext(t *testing.T) {
	for _, mode := range []string{"standalone", "mapped_cluster"} {
		for _, profile := range []string{"default_timeout", "extended_timeout"} {
			for _, termination := range []string{"deadline", "cancellation"} {
				t.Run(mode+"/"+profile+"/"+termination, func(t *testing.T) {
					assertMembershipTLSContext(t, mode, profile, termination)
				})
			}
		}
	}
}

func assertMembershipTLSContext(t *testing.T, mode, profile, termination string) {
	t.Helper()
	address, started, closed := stalledMembershipTLSListener(t)
	query := ""
	if profile == "extended_timeout" {
		query = "?dial_timeout=30s"
	}
	env := map[string]string{"AUTH_MEMBERSHIP_REDIS_URL": "rediss://member:fixture@" + address + query}
	if mode == "mapped_cluster" {
		env["AUTH_MEMBERSHIP_REDIS_CLUSTER_NODES"] = "rediss://member:fixture@announced-node:6379" + query
		env["AUTH_MEMBERSHIP_REDIS_NODE_ADDRESS_MAP"] = "announced-node:6379=" + address
	}
	client, err := membershipRedisClient(func(key string) string { return env[key] })
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- client.Ping(ctx).Err() }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("client did not begin the TLS handshake")
	}
	want := context.DeadlineExceeded
	if termination == "cancellation" {
		want = context.Canceled
		cancel()
	}
	select {
	case err := <-result:
		if !errors.Is(ctx.Err(), want) || !errors.Is(err, want) {
			t.Fatalf("TLS operation returned %v; context error %v", err, ctx.Err())
		}
	case <-time.After(time.Second):
		t.Fatal("TLS handshake ignored context termination and exceeded the attempt bound")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("canceled TLS handshake left its TCP connection open")
	}
}

func TestMembershipRedisTLSDialTimeoutRemainsEffective(t *testing.T) {
	for _, mode := range []string{"standalone", "mapped_cluster"} {
		t.Run(mode, func(t *testing.T) {
			address, _, _ := stalledMembershipTLSListener(t)
			env := map[string]string{"AUTH_MEMBERSHIP_REDIS_URL": "rediss://" + address + "?dial_timeout=100ms"}
			if mode == "mapped_cluster" {
				env["AUTH_MEMBERSHIP_REDIS_CLUSTER_NODES"] = "rediss://announced-node:6379?dial_timeout=100ms"
				env["AUTH_MEMBERSHIP_REDIS_NODE_ADDRESS_MAP"] = "announced-node:6379=" + address
			}
			client, err := membershipRedisClient(func(key string) string { return env[key] })
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			var options *redis.Options
			if cluster, ok := client.(*redis.ClusterClient); ok {
				profile := cluster.Options()
				node := profile.NewClient(&redis.Options{Addr: "announced-node:6379", TLSConfig: profile.TLSConfig, DialTimeout: profile.DialTimeout})
				defer node.Close()
				options = node.Options()
			} else {
				options = client.(*redis.Client).Options()
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			start := time.Now()
			conn, err := options.Dialer(ctx, options.Network, options.Addr)
			if conn != nil {
				conn.Close()
			}
			var timeout net.Error
			if !errors.As(err, &timeout) || !timeout.Timeout() || ctx.Err() != nil || time.Since(start) > time.Second {
				t.Fatalf("configured TLS dial timeout was lost: %v (context: %v)", err, ctx.Err())
			}
		})
	}
}

// Accept TCP and read the ClientHello, but never answer it. Each test owns its
// listener and connection; cleanup also unblocks the server on a failing test.
func stalledMembershipTLSListener(t *testing.T) (string, <-chan struct{}, <-chan struct{}) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	accepted := make(chan net.Conn, 1)
	started := make(chan struct{})
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		accepted <- conn
		var firstByte [1]byte
		if _, err := io.ReadFull(conn, firstByte[:]); err != nil {
			return
		}
		close(started)
		_, _ = io.Copy(io.Discard, conn)
	}()
	t.Cleanup(func() {
		listener.Close()
		select {
		case conn := <-accepted:
			conn.Close()
		case <-closed:
		}
		<-closed
	})
	return listener.Addr().String(), started, closed
}
