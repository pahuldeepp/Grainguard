package main

import (
	"context"
	"errors"
	"testing"

	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
)

func TestStartupFailureClosesResourceExactlyOnce(t *testing.T) {
	failure := errors.New("startup unavailable")
	for _, name := range []string{"database ping", "membership consumer startup"} {
		t.Run(name, func(t *testing.T) {
			closed := 0
			err := closeOnStartupError(func() error { return failure }, func() { closed++ })
			if !errors.Is(err, failure) || closed != 1 {
				t.Fatalf("startup failure lost cleanup/error: closes=%d error=%v", closed, err)
			}
		})
	}
	closed := 0
	if err := closeOnStartupError(func() error { return nil }, func() { closed++ }); err != nil || closed != 0 {
		t.Fatal("successful startup closed the live resource")
	}
}

type retryVersionRedis struct {
	*versionRedis
	attempts []string
	failures int
}

func (r *retryVersionRedis) Eval(ctx context.Context, script string, keys []string, args ...interface{}) *redis.Cmd {
	r.attempts = append(r.attempts, args[0].(string))
	if r.failures > 0 {
		r.failures--
		return redis.NewCmdResult(nil, errors.New("Redis temporarily unavailable"))
	}
	return r.versionRedis.Eval(ctx, script, keys, args...)
}

func TestMembershipRetriesSameRecordAfterTransientApplyFailure(t *testing.T) {
	versions := &retryVersionRedis{versionRedis: &versionRedis{versions: map[string]string{}}, failures: 1}
	cache := &controlMembershipCache{redis: versions, floors: map[string]map[string]uint64{}, entries: map[string]membershipEntry{}}
	fake := &failingMembershipConsumer{}
	var committed []int64
	err := cache.consumeMembershipBatch(context.Background(), fake.PollFetches(context.Background()), func(_ context.Context, records ...*kgo.Record) error {
		committed = append(committed, records[0].Offset)
		return nil
	})
	if err != nil || len(versions.attempts) != 3 || versions.attempts[0] != "1" || versions.attempts[1] != "1" || versions.attempts[2] != "2" {
		t.Fatalf("failed application did not retry the same record: attempts=%v error=%v", versions.attempts, err)
	}
	if len(committed) != 2 || committed[0] != 1 || committed[1] != 2 || cache.membershipConsumerError() != nil {
		t.Fatalf("recovery commit/status ordering: offsets=%v error=%v", committed, cache.membershipConsumerError())
	}
}

func TestMembershipRetriesSameOffsetAfterTransientCommitFailure(t *testing.T) {
	versions := &versionRedis{versions: map[string]string{}}
	cache := &controlMembershipCache{redis: versions, floors: map[string]map[string]uint64{}, entries: map[string]membershipEntry{}}
	fake := &failingMembershipConsumer{}
	var attempts []int64
	err := cache.consumeMembershipBatch(context.Background(), fake.PollFetches(context.Background()), func(_ context.Context, records ...*kgo.Record) error {
		attempts = append(attempts, records[0].Offset)
		if len(attempts) == 1 {
			return errors.New("commit temporarily unavailable")
		}
		return nil
	})
	if err != nil || len(attempts) != 3 || attempts[0] != 1 || attempts[1] != 1 || attempts[2] != 2 {
		t.Fatalf("commit retry advanced to another record: offsets=%v error=%v", attempts, err)
	}
	if versions.versions[membershipRedisKey("identity", "tenant")] != "2" || cache.membershipConsumerError() != nil {
		t.Fatal("successful retry did not restore monotonic admission")
	}
}

func TestMembershipExhaustedApplyRetryClosesConsumerAndHoldsLaterOffset(t *testing.T) {
	versions := &retryVersionRedis{versionRedis: &versionRedis{versions: map[string]string{}}, failures: membershipRecordAttempts}
	cache := &controlMembershipCache{redis: versions, floors: map[string]map[string]uint64{}, entries: map[string]membershipEntry{}}
	fake := &failingMembershipConsumer{}
	cache.consumeMembership(context.Background(), fake)
	if len(versions.attempts) != membershipRecordAttempts || fake.commits != 0 || fake.closed != 1 || fake.polls != 1 {
		t.Fatalf("retry bound/offset/resource state violated: attempts=%v commits=%d closed=%d polls=%d", versions.attempts, fake.commits, fake.closed, fake.polls)
	}
	for _, version := range versions.attempts {
		if version != "1" {
			t.Fatal("later membership applied after exhausted retry")
		}
	}
	if !errors.Is(cache.membershipConsumerError(), errMembershipUnavailable) {
		t.Fatal("exhausted retry did not fail admission closed")
	}
}

func TestMembershipRetryCancellationClosesConsumerWithoutLaterCommit(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cache := &controlMembershipCache{}
	fake := &failingMembershipConsumer{}
	cache.consumeMembership(ctx, fake)
	if fake.closed != 1 || fake.polls != 0 || fake.commits != 0 {
		t.Fatal("shutdown did not close the consumer before polling or committing")
	}
}

func TestMembershipConsumerCleanupRunsOnce(t *testing.T) {
	cache := &controlMembershipCache{}
	fake := &failingMembershipConsumer{}
	cache.closeMembershipConsumer(fake)
	cache.closeMembershipConsumer(fake)
	if fake.closed != 1 || fake.left != 1 {
		t.Fatalf("consumer resources closed repeatedly: closes=%d leaves=%d", fake.closed, fake.left)
	}
}
