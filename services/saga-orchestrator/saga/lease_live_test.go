package saga

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
)

// serializeLeaseTests holds a session advisory lock so lease tests in other
// packages (cmd/worker) cannot take this test's expired shards mid-scenario.
func serializeLeaseTests(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext('saga-lease-live-tests'))`); err != nil {
		conn.Release()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = conn.Exec(context.Background(), `SELECT pg_advisory_unlock(hashtext('saga-lease-live-tests'))`)
		conn.Release()
	})
}

func acquireAll(t *testing.T, ctx context.Context, pool *pgxpool.Pool, holder string, ttl time.Duration) (*Leases, map[int]int64) {
	t.Helper()
	l := &Leases{DB: pool, Holder: holder, TTL: ttl, MaxShards: ShardCount}
	// Other live test packages may hold short leases; wait for them to expire.
	var held map[int]int64
	var err error
	for end := time.Now().Add(8 * time.Second); len(held) == 0 && time.Now().Before(end); time.Sleep(200 * time.Millisecond) {
		if held, err = l.Renew(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if len(held) == 0 {
		t.Fatalf("renew %s: no free shard", holder)
	}
	t.Cleanup(func() { _ = l.Release(context.Background()) })
	return l, held
}

func tenantInShards(t *testing.T, held map[int]int64) string {
	t.Helper()
	for i := 0; i < 10000; i++ {
		id := testUUID(t)
		if _, ok := held[ShardFor(id)]; ok {
			return id
		}
	}
	t.Fatal("no tenant maps to a held shard")
	return ""
}

func assertSQLShard(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenant string, shard int) {
	t.Helper()
	var sqlShard int
	if err := pool.QueryRow(ctx, `SELECT get_byte(sha256(convert_to($1,'UTF8')),0) % 64`, tenant).Scan(&sqlShard); err != nil || sqlShard != shard {
		t.Fatalf("Go/SQL shard function differ: %d %d %v", shard, sqlShard, err)
	}
}

func assertTenantSelected(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenant string, shard int) {
	t.Helper()
	ids, err := TenantsWithWork(ctx, pool, shard, "", 500)
	if err != nil || !contains(ids, tenant) {
		t.Fatalf("selector missed tenant with work: %v", err)
	}
}

func countingPublish(n *int) PublishCommand {
	return func(context.Context, []byte, []byte) error { *n++; return nil }
}

func TestLiveExpiredLeaseCannotPublishAfterNewerToken(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	serializeLeaseTests(t, ctx, pool)
	a, heldA := acquireAll(t, ctx, pool, "stale-"+testUUID(t), time.Second)
	tenant := tenantInShards(t, heldA)
	shard := ShardFor(tenant)
	assertSQLShard(t, ctx, pool, tenant, shard)
	staleStore := Store{DB: pool, Fence: a}
	first := startTransitionTest(t, ctx, staleStore, tenant, testUUID(t))
	assertTenantSelected(t, ctx, pool, tenant, shard)
	var published int
	if sent, err := staleStore.PublishNextCommand(ctx, tenant, countingPublish(&published)); err != nil || !sent {
		t.Fatalf("current holder publish: %v %v", sent, err)
	}
	startTransitionTest(t, ctx, staleStore, tenant, testUUID(t))
	time.Sleep(1300 * time.Millisecond) // the stale worker "pauses" past its TTL
	b, heldB := acquireAll(t, ctx, pool, "fresh-"+testUUID(t), 10*time.Second)
	if heldB[shard] <= heldA[shard] {
		t.Fatalf("takeover token %d must exceed stale token %d", heldB[shard], heldA[shard])
	}
	if _, err := staleStore.PublishNextCommand(ctx, tenant, countingPublish(&published)); !errors.Is(err, ErrLeaseLost) || published != 1 {
		t.Fatalf("stale worker published after takeover: err=%v published=%d", err, published)
	}
	expireNow(t, ctx, pool, tenant, first.SagaID)
	if _, err := staleStore.ExpireDue(ctx, tenant, 10); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale worker compensated after takeover: %v", err)
	}
	if again, err := a.Renew(ctx); err != nil || again[shard] != 0 {
		t.Fatalf("stale worker regained a live lease: %v %v", again, err)
	}
	fresh := Store{DB: pool, Fence: b}
	if sent, err := fresh.PublishNextCommand(ctx, tenant, countingPublish(&published)); err != nil || !sent {
		t.Fatalf("new holder publish: %v %v", sent, err)
	}
	if n, err := fresh.ExpireDue(ctx, tenant, 10); err != nil || n != 1 {
		t.Fatalf("new holder compensation: %d %v", n, err)
	}
}

func TestLiveLeaseTakeoverWaitsForInFlightSideEffect(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	serializeLeaseTests(t, ctx, pool)
	a, heldA := acquireAll(t, ctx, pool, "slow-"+testUUID(t), time.Second)
	tenant := tenantInShards(t, heldA)
	shard := ShardFor(tenant)
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = common.Rollback(tx) }()
	if err := a.Check(ctx, tx, tenant); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1300 * time.Millisecond)
	b := &Leases{DB: pool, Holder: "waiting-" + testUUID(t), TTL: 5 * time.Second, MaxShards: ShardCount}
	t.Cleanup(func() { _ = b.Release(context.Background()) })
	during, err := b.Renew(ctx)
	if err != nil || during[shard] != 0 {
		t.Fatalf("takeover overlapped an in-flight fenced transaction: %v %v", during, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	after, err := b.Renew(ctx)
	if err != nil || after[shard] <= heldA[shard] {
		t.Fatalf("takeover after commit: %v %v", after, err)
	}
	if err := (&Leases{DB: pool, Holder: "x", TTL: time.Millisecond, MaxShards: 1}).Check(ctx, nil, tenant); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("unheld shard check: %v", err)
	}
	if _, err := (&Leases{DB: pool}).Renew(ctx); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("invalid lease config: %v", err)
	}
	if _, err := TenantsWithWork(ctx, pool, ShardCount, "", 1); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("invalid shard: %v", err)
	}
}

func contains(ids []string, id string) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

func expireNow(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenant, sagaID string) {
	t.Helper()
	if err := common.WithTenantSchema(ctx, pool, tenant, "", func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE provisioning_sagas SET deadline_at=now()-interval '1 second'
			WHERE tenant_id=$1 AND saga_id=$2`, tenant, sagaID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
}
