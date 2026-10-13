package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestRedisClusterPreservesURLCredentialsAndTLS(t *testing.T) {
	client, err := newRedis(func(key string) string {
		if key == "READ_REDIS_CLUSTER_NODES" {
			return "rediss://worker:privatePassword@node-a:6379,rediss://worker:privatePassword@node-b:6379"
		}
		return ""
	}, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	options := client.client.(*redis.ClusterClient).Options()
	if options.Username != "worker" || options.Password != "privatePassword" || options.TLSConfig == nil || strings.Join(options.Addrs, ",") != "node-a:6379,node-b:6379" {
		t.Fatal("cluster connection lost its authentication, TLS, or address profile")
	}
}

func TestRedisClusterRejectsMixedProfilesAndDatabaseSelection(t *testing.T) {
	for _, nodes := range []string{
		"redis://:alpha@node-a:6379,redis://:beta@node-b:6379",
		"rediss://:alpha@node-a:6379,redis://:alpha@node-b:6379",
		"redis://:alpha@node-a:6379,node-b:6379",
		"redis://node-a:6379/1", "http://node-a:6379",
	} {
		_, err := newRedis(func(key string) string {
			if key == "READ_REDIS_CLUSTER_NODES" {
				return nodes
			}
			return ""
		}, time.Second)
		if err == nil {
			t.Fatal("invalid cluster profile accepted")
		}
		if strings.Contains(err.Error(), "alpha") || strings.Contains(err.Error(), "beta") {
			t.Fatal("error leaked a credential")
		}
	}
}

func TestRedisClusterKeepsLegacyUnauthenticatedAddresses(t *testing.T) {
	client, err := newRedis(func(key string) string {
		if key == "READ_REDIS_CLUSTER_NODES" {
			return "node-a:6379,node-b:6379"
		}
		return ""
	}, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if client.client.(*redis.ClusterClient).Options().Password != "" {
		t.Fatal("legacy profile acquired an unexpected credential")
	}
}

func TestRedisTLSMappingVerifiesOriginalHostname(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer server.Close()
	certificate := server.Certificate()
	roots := x509.NewCertPool()
	roots.AddCert(certificate)
	_, port, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	address := net.JoinHostPort(certificate.DNSNames[0], port)
	config := &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	connection, err := redisDialer(map[string]string{address: server.Listener.Addr().String()}, time.Second, config)(ctx, "tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	connection.Close()
	foreign := net.JoinHostPort("not-in-certificate.invalid", port)
	connection, err = redisDialer(map[string]string{foreign: server.Listener.Addr().String()}, time.Second, config)(ctx, "tcp", foreign)
	if err == nil {
		connection.Close()
		t.Fatal("mapped connection skipped TLS hostname verification")
	}
	if config.ServerName != "" {
		t.Fatal("dialer mutated shared TLS configuration")
	}
}

func TestRedisSingleNodeConfigurationAndInvalidInputs(t *testing.T) {
	for _, url := range []string{"redis://worker:privatePassword@localhost:6379/2", "rediss://worker:privatePassword@localhost:6379/0"} {
		client, err := newRedis(func(key string) string {
			if key == "READ_REDIS_URL" {
				return url
			}
			return ""
		}, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		options := client.client.(*redis.Client).Options()
		if options.Username != "worker" || options.Password != "privatePassword" || options.Dialer == nil || options.MaxRetries != 0 {
			t.Fatal("single-node connection configuration was lost")
		}
		if strings.HasPrefix(url, "rediss:") && options.TLSConfig == nil {
			t.Fatal("TLS was lost")
		}
		client.Close()
	}
	for _, values := range []map[string]string{{}, {"READ_REDIS_URL": "http://bad"}, {"READ_REDIS_NODE_ADDRESS_MAP": "not-json"}, {"READ_REDIS_CLUSTER_NODES": "redis://localhost:not-a-port"}} {
		if client, err := newRedis(func(key string) string { return values[key] }, time.Second); err == nil {
			client.Close()
			t.Fatal("invalid connection accepted")
		}
	}
}

func TestRedisBumperLiveScriptsAndConnection(t *testing.T) {
	url := os.Getenv("FRESHNESS_REDIS_URL")
	if url == "" {
		t.Skip("FRESHNESS_REDIS_URL isolated Redis required")
	}
	bumper, err := newRedis(func(key string) string {
		if key == "READ_REDIS_URL" {
			return url
		}
		return ""
	}, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer bumper.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := bumper.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	target := Target{Scope: scopeTenant, Tenant: "77777777-7777-4777-8777-777777777777"}
	guard := watermarkGuardKey(target.Tenant)
	defer bumper.client.Del(ctx, target.Key(), guard, guard+":revision", epochKey)
	if err := bumper.client.Set(ctx, guard, "old", time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	if err := bumper.BumpTarget(ctx, target, 100, time.Minute); err != nil {
		t.Fatal(err)
	}
	if v, err := bumper.client.Get(ctx, target.Key()).Int64(); err != nil || v != 100 {
		t.Fatalf("version=%d error=%v", v, err)
	}
	if n, err := bumper.client.Exists(ctx, guard).Result(); err != nil || n != 0 {
		t.Fatal("legacy guard retained", err)
	}
	if err := bumper.Bump(ctx, epochKey, 200, 0); err != nil {
		t.Fatal(err)
	}
	if err := bumper.Bump(ctx, "invalid", 0, 0); err == nil {
		t.Fatal("invalid key accepted")
	}
	target.Incarnation = "fenced"
	if err := bumper.BumpTarget(ctx, target, 101, time.Minute); err != nil {
		t.Fatal(err)
	}
}
