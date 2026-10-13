package main

import (
	"context"
	"crypto/tls"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
)

func TestMembershipRedisClusterRetainsTLSAndAuthentication(t *testing.T) {
	env := map[string]string{
		"AUTH_MEMBERSHIP_REDIS_CLUSTER_NODES":    "rediss://member:fixture-password@node-a:6379,rediss://member:fixture-password@node-b:6380",
		"AUTH_MEMBERSHIP_REDIS_NODE_ADDRESS_MAP": "node-a:6379=localhost:16379",
	}
	rc, err := membershipRedisClient(func(key string) string { return env[key] })
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	cluster := rc.(*redis.ClusterClient)
	options := cluster.Options()
	if options.Username != "member" || options.Password != "fixture-password" || len(options.Addrs) != 2 {
		t.Fatal("cluster credentials or seeds were dropped")
	}
	if options.TLSConfig == nil || options.TLSConfig.InsecureSkipVerify || options.TLSConfig.MinVersion < tls.VersionTLS12 {
		t.Fatal("cluster TLS verification was weakened")
	}
	assertMembershipRedisNode(t, options, "node-a:6379", "localhost:16379", "node-a")
	assertMembershipRedisNode(t, options, "discovered-node:6379", "discovered-node:6379", "discovered-node")
	if options.TLSConfig.ServerName != "" {
		t.Fatal("per-node TLS setup mutated the shared profile")
	}
}

func assertMembershipRedisNode(t *testing.T, options *redis.ClusterOptions, announced, mapped, serverName string) {
	t.Helper()
	node := options.NewClient(&redis.Options{Addr: announced, Username: options.Username, Password: options.Password, TLSConfig: options.TLSConfig})
	defer node.Close()
	actual := node.Options()
	if actual.Addr != mapped || actual.Username != "member" || actual.Password != "fixture-password" {
		t.Fatal("node mapping discarded credentials or mapped the wrong endpoint")
	}
	if actual.TLSConfig == options.TLSConfig || actual.TLSConfig.ServerName != serverName || actual.TLSConfig.InsecureSkipVerify {
		t.Fatal("node TLS identity was shared, mapped incorrectly or not verified")
	}
}

func TestMembershipRedisClusterRejectsInvalidAndMixedProfiles(t *testing.T) {
	for _, nodes := range [][]string{
		nil,
		{"redis://node-a", "rediss://node-b"},
		{"rediss://member:first@node-a", "rediss://member:second@node-b"},
		{"rediss://member:first@node-a", "rediss://other:first@node-b"},
		{"rediss://member:first@node-a", "rediss://node-b"},
		{"redis://node-a?dial_timeout=1s", "redis://node-b?dial_timeout=2s"},
		{"redis://node-a?protocol=2", "redis://node-b?protocol=3"},
		{"rediss://node-a?skip_verify=true"},
		{"redis://node-a/1"},
		{"redis://node-a?read_only=true"},
		{"redis://node-a?route_by_latency=true"},
		{"redis://node-a?addr=node-b:6379"},
		{"http://node-a"},
		{"redis://node-a#fragment"},
		{"redis://node-a", ""},
	} {
		if _, err := membershipRedisClusterOptions(nodes); err == nil {
			t.Fatal("invalid or mixed Redis cluster profile accepted")
		}
	}
	for _, raw := range []string{",redis://node-a", "redis://node-a,"} {
		_, err := membershipRedisClient(func(key string) string {
			if key == "AUTH_MEMBERSHIP_REDIS_CLUSTER_NODES" {
				return raw
			}
			return "redis://localhost:6379"
		})
		if err == nil {
			t.Fatal("invalid cluster list silently fell back to standalone Redis")
		}
	}
}

func TestMembershipRedisClusterRetainsConsistentConnectionOptions(t *testing.T) {
	options, err := membershipRedisClusterOptions([]string{
		"rediss://member:fixture@node-a/0?protocol=2&dial_timeout=1s",
		"rediss://member:fixture@node-b/0?dial_timeout=1s&protocol=2",
	})
	if err != nil || options.Protocol != 2 || options.DialTimeout != time.Second || options.Addrs[0] != "node-a:6379" {
		t.Fatalf("consistent connection profile not preserved: error=%v", err)
	}
}

func TestMembershipRedisStandaloneRejectsTLSVerificationBypass(t *testing.T) {
	_, err := membershipRedisClient(func(key string) string {
		if key == "AUTH_MEMBERSHIP_REDIS_URL" {
			return "rediss://member:fixture@node-a?skip_verify=true"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "verification") {
		t.Fatalf("TLS verification bypass accepted: %v", err)
	}
}

type failingMembershipConsumer struct {
	failure error
	commits int
	polls   int
	closed  int
	left    int
}

func (f *failingMembershipConsumer) PollFetches(context.Context) kgo.Fetches {
	f.polls++
	return kgo.Fetches{{Topics: []kgo.FetchTopic{{Topic: "memberships", Partitions: []kgo.FetchPartition{{Partition: 0, Records: []*kgo.Record{
		{Topic: "memberships", Partition: 0, Offset: 1, Value: []byte(`{"event_type":"membership.changed","tenant_id":"tenant","payload":{"identity_id":"identity","membership_version":"1"}}`)},
		{Topic: "memberships", Partition: 0, Offset: 2, Value: []byte(`{"event_type":"membership.changed","tenant_id":"tenant","payload":{"identity_id":"identity","membership_version":"2"}}`)},
	}}}}}}}
}

func (f *failingMembershipConsumer) CommitRecords(context.Context, ...*kgo.Record) error {
	f.commits++
	return f.failure
}

func (f *failingMembershipConsumer) LeaveGroupContext(ctx context.Context) error {
	f.left++
	if _, ok := ctx.Deadline(); !ok {
		return errors.New("unbounded group leave")
	}
	return nil
}

func (f *failingMembershipConsumer) Close() { f.closed++ }

func TestMembershipConsumerStopsSamePartitionAfterApplyOrCommitFailure(t *testing.T) {
	for _, tc := range []struct {
		name       string
		applyFails bool
		commits    int
		floor      string
	}{
		{"apply failure", true, 0, ""},
		{"commit failure", false, membershipRecordAttempts, "1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			versions := &versionRedis{versions: map[string]string{}, down: tc.applyFails}
			fake := &failingMembershipConsumer{failure: errors.New("commit unavailable")}
			id := identityID("issuer", "subject")
			cache := &controlMembershipCache{redis: versions, entries: map[string]membershipEntry{id: {value: &controlMembership{TenantID: "tenant", Roles: []string{"operator"}, State: "active", Version: "1"}, fetched: time.Now()}}, floors: map[string]map[string]uint64{}}
			cache.consumeMembership(context.Background(), fake)
			if fake.closed != 1 || fake.polls != 1 || fake.commits != tc.commits || versions.versions[membershipRedisKey("identity", "tenant")] != tc.floor {
				t.Fatal("later same-partition record advanced past the failed record")
			}
			if tenant, roles, err := cache.roles(context.Background(), "issuer", "subject"); err == nil || tenant != "" || roles != nil {
				t.Fatal("failed membership consumer allowed cached authorization")
			}
		})
	}
}

func TestMembershipConsumerPropagatesDiscardCommitFailure(t *testing.T) {
	cache := &controlMembershipCache{}
	failure := errors.New("commit unavailable")
	err := cache.consumeMembershipRecord(context.Background(), &kgo.Record{Value: []byte("{")}, func(context.Context, ...*kgo.Record) error { return failure })
	if !errors.Is(err, failure) {
		t.Fatalf("discard commit error was lost: %v", err)
	}
}

func TestMembershipConsumerFailureFailsHealthCheck(t *testing.T) {
	cache := &controlMembershipCache{consumerErr: errors.New("membership consumer unavailable")}
	api := &server{auth: &verifier{membershipCache: cache}}
	response := httptest.NewRecorder()
	api.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("failed membership consumer remained healthy: %d", response.Code)
	}
	cache.consumerErr = nil
	response = httptest.NewRecorder()
	api.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("healthy membership consumer returned %d", response.Code)
	}
}

func TestMembershipRedisTLSUsesAnnouncedHostBeforeMapping(t *testing.T) {
	env := map[string]string{
		"AUTH_MEMBERSHIP_REDIS_CLUSTER_NODES":    "rediss://member:fixture-password@node-a:6379",
		"AUTH_MEMBERSHIP_REDIS_NODE_ADDRESS_MAP": "node-without-port=localhost:16379,[2001:db8::1]:6379=localhost:16380,2001:db8::2=localhost:16381,[broken=localhost:16382,:6379=localhost:16383",
	}
	rc, err := membershipRedisClient(func(key string) string { return env[key] })
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	options := rc.(*redis.ClusterClient).Options()
	for _, tc := range []struct {
		announced, mapped, serverName string
	}{
		{"node-without-port", "localhost:16379", "node-without-port"},
		{"[2001:db8::1]:6379", "localhost:16380", "2001:db8::1"},
		{"2001:db8::2", "localhost:16381", "2001:db8::2"},
		{"[broken", "localhost:16382", "[broken"},
		{":6379", "localhost:16383", ":6379"},
	} {
		t.Run(tc.announced, func(t *testing.T) {
			assertMembershipRedisNode(t, options, tc.announced, tc.mapped, tc.serverName)
		})
	}
	if options.TLSConfig.ServerName != "" || options.TLSConfig.InsecureSkipVerify {
		t.Fatal("announced-host fallback mutated or weakened the shared TLS profile")
	}
}
