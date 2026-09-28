package main

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
)

// canonicalReference folds a finite Kafka snapshot independently of the shadow
// inbox. Any missing prefix, offset discontinuity, or invalid event fails closed.
func canonicalReference(ctx context.Context, client *kgo.Client, parts []replayPartition, validator *Processor, cutoffs ...time.Time) (map[string]referenceState, error) {
	if len(parts) == 0 || validator == nil {
		return nil, errors.New("canonical source or validator unavailable")
	}
	fold, assignments, err := newCanonicalFold(parts, validator)
	if err != nil {
		return nil, err
	}
	if len(cutoffs) > 0 {
		fold.cutoff = cutoffs[0]
	}
	client.AddConsumePartitions(assignments)
	client.ResumeFetchPartitions(assignedPartitions(assignments))
	defer func() { client.RemoveConsumePartitions(assignedPartitions(assignments)) }()
	for fold.remaining > 0 {
		fetches := client.PollRecords(ctx, 1)
		if err := fetches.Err(); err != nil {
			return nil, err
		}
		for _, record := range fetches.Records() {
			done, err := fold.consume(record)
			if err != nil {
				return nil, err
			}
			if done {
				client.PauseFetchPartitions(map[string][]int32{record.Topic: {record.Partition}})
			}
		}
	}
	return fold.result()
}

// canonicalFold tracks the next expected offset per partition and folds
// validated events into per-tenant accumulators.
type canonicalFold struct {
	validator    *Processor
	next, end    map[string]int64
	accumulators map[string]*canonicalAccumulator
	remaining    int
	cutoff       time.Time
}

func topicPartitionKey(topic string, partition int32) string {
	return fmt.Sprintf("%s/%d", topic, partition)
}

func newCanonicalFold(parts []replayPartition, validator *Processor) (*canonicalFold, map[string]map[int32]kgo.Offset, error) {
	fold := &canonicalFold{validator: validator, next: map[string]int64{}, end: map[string]int64{}, accumulators: map[string]*canonicalAccumulator{}}
	assignments := map[string]map[int32]kgo.Offset{}
	for _, p := range parts {
		if p.Start != 0 || p.End < p.Start {
			return nil, nil, fmt.Errorf("canonical prefix unavailable: %s/%d", p.Topic, p.Partition)
		}
		key := topicPartitionKey(p.Topic, p.Partition)
		if _, ok := fold.next[key]; ok {
			return nil, nil, fmt.Errorf("duplicate canonical partition %s", key)
		}
		fold.next[key] = p.Start
		fold.end[key] = p.End
		if p.Start < p.End {
			if assignments[p.Topic] == nil {
				assignments[p.Topic] = map[int32]kgo.Offset{}
			}
			assignments[p.Topic][p.Partition] = kgo.NewOffset().At(p.Start)
			fold.remaining++
		}
	}
	return fold, assignments, nil
}

func assignedPartitions(assignments map[string]map[int32]kgo.Offset) map[string][]int32 {
	out := map[string][]int32{}
	for topic, ps := range assignments {
		for partition := range ps {
			out[topic] = append(out[topic], partition)
		}
	}
	return out
}

// consume folds one record and reports whether its partition just completed.
func (f *canonicalFold) consume(record *kgo.Record) (bool, error) {
	key := topicPartitionKey(record.Topic, record.Partition)
	expected, ok := f.next[key]
	if !ok || expected == f.end[key] {
		return false, nil
	}
	if record.Offset != expected {
		return false, fmt.Errorf("canonical offset discontinuity %s: expected %d got %d", key, expected, record.Offset)
	}
	m := Message{Topic: record.Topic, Partition: record.Partition, Offset: record.Offset, Key: record.Key, Value: record.Value, Headers: record.Headers}
	if err := f.foldMessage(key, m); err != nil {
		return false, err
	}
	f.next[key]++
	if f.next[key] != f.end[key] {
		return false, nil
	}
	f.remaining--
	return true, nil
}

func (f *canonicalFold) foldMessage(key string, m Message) error {
	if string(m.Key) == bindingHeartbeatKey {
		if _, err := parseCheckpoint(m, 6); err != nil {
			return fmt.Errorf("invalid canonical heartbeat: %w", err)
		}
		return nil
	}
	e, reason := f.validator.validate(m)
	if reason != "" {
		return fmt.Errorf("poison canonical event %s/%d: %s", key, m.Offset, reason)
	}
	tenant := e[fieldTenant].(string)
	if f.accumulators[tenant] == nil {
		f.accumulators[tenant] = newCanonicalAccumulator(f.cutoff)
	}
	if err := f.accumulators[tenant].add(e); err != nil {
		return fmt.Errorf("canonical fold %s/%d: %w", key, m.Offset, err)
	}
	return nil
}

func (f *canonicalFold) result() (map[string]referenceState, error) {
	if len(f.accumulators) == 0 {
		return nil, errors.New("canonical snapshot contains no tenant events")
	}
	result := map[string]referenceState{}
	for tenant, acc := range f.accumulators {
		result[tenant] = acc.finish()
		if acc.domainErr != nil {
			return nil, fmt.Errorf("canonical domain fold for tenant %s: %w", tenant, acc.domainErr)
		}
	}
	return result, nil
}

// frontierMismatch returns the key of the first observed partition that is
// absent from reference or differs in topic ID or bounds.
func frontierMismatch(reference, observed []replayPartition) (string, bool) {
	byKey := make(map[string]replayPartition, len(reference))
	for _, p := range reference {
		byKey[topicPartitionKey(p.Topic, p.Partition)] = p
	}
	for _, p := range observed {
		key := topicPartitionKey(p.Topic, p.Partition)
		old, ok := byKey[key]
		if !ok || p.TopicID != old.TopicID || p.Start != old.Start || p.End != old.End {
			return key, true
		}
	}
	return "", false
}

// canonicalTenantSet requires the replay registry to name exactly the source tenants.
func canonicalTenantSet(canonical map[string]referenceState, replayed []string) error {
	if len(canonical) == 0 {
		return errors.New("empty canonical reference")
	}
	keys := make([]string, 0, len(canonical))
	for tenant := range canonical {
		keys = append(keys, tenant)
	}
	sort.Strings(keys)
	sort.Strings(replayed)
	if !reflect.DeepEqual(keys, replayed) {
		return fmt.Errorf("canonical/replay tenant sets differ: %v / %v", keys, replayed)
	}
	return nil
}

// verifyCanonicalComparison refuses a stale shadow and checks the independent
// source fold against both versions. The live version is the current public
// projection; routing via read.* is verified separately by promotion tooling.
func verifyCanonicalComparison(ctx context.Context, client *kgo.Client, validator *Processor, pool *pgxpool.Pool, parts []replayPartition, shadowSchema string) error {
	if err := requireShadowCaughtUp(parts); err != nil {
		return err
	}
	cutoff, err := comparisonCutoff(ctx, pool)
	if err != nil {
		return err
	}
	canonical, err := canonicalReference(ctx, client, parts, validator, cutoff)
	if err != nil {
		return err
	}
	replayed, err := replayedTenants(ctx, pool, shadowSchema)
	if err != nil {
		return err
	}
	if err := canonicalTenantSet(canonical, replayed); err != nil {
		return err
	}
	for tenant, want := range canonical {
		if err := compareTenantSchemas(ctx, pool, tenant, want, cutoff, shadowSchema, "public"); err != nil {
			return err
		}
	}
	// A later append changes the frontier. A promotion proof cannot use this run.
	after, err := replayBounds(ctx, client)
	if err != nil {
		return err
	}
	if len(after) != len(parts) {
		return errors.New("canonical partition set changed during verification")
	}
	if key, changed := frontierMismatch(parts, after); changed {
		return fmt.Errorf("canonical frontier changed during verification: %s", key)
	}
	return nil
}

func requireShadowCaughtUp(parts []replayPartition) error {
	for _, p := range parts {
		if err := replayCheckBounds(p); err != nil {
			return err
		}
		if p.Next != p.End {
			return fmt.Errorf("shadow lag %s/%d: %d != %d", p.Topic, p.Partition, p.Next, p.End)
		}
	}
	return nil
}

func replayedTenants(ctx context.Context, pool *pgxpool.Pool, shadowSchema string) ([]string, error) {
	var replayed []string
	err := WithTenantSchema(ctx, pool, infrastructureTenant, shadowSchema, func(ctx context.Context, tx pgx.Tx) error {
		return queryEachRow(ctx, tx, `SELECT event_tenant::text FROM projection_replay_tenants WHERE tenant_id=$1 ORDER BY event_tenant`, func(rows pgx.Rows) error {
			var tenant string
			if err := rows.Scan(&tenant); err != nil {
				return err
			}
			replayed = append(replayed, tenant)
			return nil
		}, infrastructureTenant)
	})
	return replayed, err
}

func compareTenantSchemas(ctx context.Context, pool *pgxpool.Pool, tenant string, want referenceState, cutoff time.Time, schemas ...string) error {
	for _, schema := range schemas {
		err := WithTenantSchema(ctx, pool, tenant, schema, func(ctx context.Context, tx pgx.Tx) error {
			got, err := readReferenceStateAt(ctx, tx, tenant, cutoff)
			if err != nil {
				return err
			}
			if !reflect.DeepEqual(want, got) {
				return fmt.Errorf("%s semantic rows differ from canonical source", schema)
			}
			return nil
		})
		if err != nil {
			return fmt.Errorf("tenant %s: %w", tenant, err)
		}
	}
	return nil
}
