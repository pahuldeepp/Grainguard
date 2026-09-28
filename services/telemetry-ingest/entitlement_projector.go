package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
	common "greenguard.local/go-common"
	transport "greenguard.local/kafka-transport"
)

const entitlementTopic = "greenguard.billing.lifecycle.v1"
const entitlementDLQ = "greenguard.billing.entitlements.dlq.v1"

type entitlementEvent struct {
	EventID          string `json:"event_id"`
	EventType        string `json:"event_type"`
	TenantID         string `json:"tenant_id"`
	AggregateType    string `json:"aggregate_type"`
	AggregateID      string `json:"aggregate_id"`
	AggregateVersion string `json:"aggregate_version"`
	Payload          struct {
		TenantID      string         `json:"tenant_id"`
		PlanKey       string         `json:"plan_key"`
		PlanVersion   string         `json:"plan_version"`
		SourceVersion string         `json:"source_version"`
		Limits        map[string]any `json:"limits"`
		Features      map[string]any `json:"features"`
		EffectiveAt   string         `json:"effective_at"`
	} `json:"payload"`
}

func parseEntitlement(raw, key []byte) (*entitlementEvent, error) {
	var e entitlementEvent
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, err
	}
	if e.EventType != "entitlements.changed" {
		return nil, nil
	}
	if !isUUID(e.TenantID) || !isUUID(e.EventID) || e.AggregateType != "entitlement" ||
		e.AggregateID != e.TenantID || e.Payload.TenantID != e.TenantID || string(key) != e.TenantID+":"+e.TenantID ||
		e.AggregateVersion != e.Payload.SourceVersion || !decimalVersion(e.Payload.SourceVersion) ||
		!decimalVersion(e.Payload.PlanVersion) || e.Payload.Limits == nil || e.Payload.Features == nil {
		return nil, errors.New("invalid entitlement identity or payload")
	}
	if _, err := time.Parse(time.RFC3339Nano, e.Payload.EffectiveAt); err != nil {
		return nil, err
	}
	switch e.Payload.PlanKey {
	case "free", "standard", "enterprise":
	default:
		return nil, errors.New("invalid plan")
	}
	for _, v := range e.Payload.Limits {
		n, ok := v.(float64)
		if !ok || n < 0 || n != float64(int64(n)) {
			return nil, errors.New("invalid limit")
		}
	}
	for _, v := range e.Payload.Features {
		if _, ok := v.(bool); !ok {
			return nil, errors.New("invalid feature")
		}
	}
	return &e, nil
}
func decimalVersion(s string) bool {
	if len(s) == 0 || len(s) > 18 || s[0] == '0' {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
func applyEntitlementEvent(ctx context.Context, db TxStarter, e *entitlementEvent) error {
	return WithTenant(ctx, db, e.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		limits, _ := json.Marshal(e.Payload.Limits)
		features, _ := json.Marshal(e.Payload.Features)
		_, err := tx.Exec(ctx, `INSERT INTO tenant_entitlements(tenant_id,plan_key,plan_version,limits,features,source_version,applied_at)
   VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,clock_timestamp())
   ON CONFLICT(tenant_id) DO UPDATE SET plan_key=excluded.plan_key,plan_version=excluded.plan_version,
   limits=excluded.limits,features=excluded.features,source_version=excluded.source_version,applied_at=excluded.applied_at
   WHERE tenant_entitlements.source_version<excluded.source_version`, e.TenantID, e.Payload.PlanKey, e.Payload.PlanVersion, string(limits), string(features), e.Payload.SourceVersion)
		return err
	})
}

// processEntitlementRecord applies one heartbeat or plan event, quarantines a
// malformed one to the DLQ, and commits the offset only after the effect.
func processEntitlementRecord(ctx context.Context, db TxStarter, client *kgo.Client, record *kgo.Record) error {
	err := applyEntitlementRecord(ctx, db, record)
	if err != nil {
		var poison poisonError
		if !errors.As(err, &poison) {
			return err
		}
		body, _ := json.Marshal(map[string]any{"source_topic": record.Topic, "partition": record.Partition, "offset": record.Offset, "reason": err.Error()})
		if err := client.ProduceSync(ctx, &kgo.Record{Topic: entitlementDLQ, Key: []byte(fmt.Sprintf("%s:%d:%d", record.Topic, record.Partition, record.Offset)), Value: body}).FirstErr(); err != nil {
			return err
		}
	}
	return client.CommitRecords(ctx, record)
}

type poisonError struct{ error }

func applyEntitlementRecord(ctx context.Context, db TxStarter, record *kgo.Record) error {
	if at, ok, err := parseHeartbeat(record.Value); err != nil {
		return poisonError{err}
	} else if ok {
		if shards, ok := db.(*common.ShardedDB); ok {
			return shards.ForEachPrimary(ctx, func(shard string, _ *pgxpool.Pool) error {
				return shards.WithInfrastructure(ctx, shard, "", func(ctx context.Context, tx pgx.Tx) error {
					return applyEntitlementHeartbeat(ctx, tx, record.Partition, at)
				})
			})
		}
		exec, ok := db.(heartbeatExec)
		if !ok {
			return errors.New("entitlement heartbeat requires explicit infrastructure executor")
		}
		return applyEntitlementHeartbeat(ctx, exec, record.Partition, at)
	}
	e, err := parseEntitlement(record.Value, record.Key)
	if err != nil {
		return poisonError{err}
	}
	if e == nil {
		return nil
	}
	return applyEntitlementEvent(ctx, db, e)
}

// heartbeatExec is satisfied by pgxpool.Pool and pgx.Conn.
type heartbeatExec interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// parseHeartbeat reports (emittedAt, true) for a feed-health heartbeat. Any other
// event type is not a heartbeat (ADR-0022).
func parseHeartbeat(raw []byte) (time.Time, bool, error) {
	var h struct {
		EventType string `json:"event_type"`
		EmittedAt string `json:"emitted_at"`
	}
	if err := json.Unmarshal(raw, &h); err != nil || h.EventType != "entitlements.heartbeat" {
		return time.Time{}, false, nil
	}
	at, err := time.Parse(time.RFC3339Nano, h.EmittedAt)
	return at, err == nil, err
}

// applyEntitlementHeartbeat records how far this consumer has read one partition.
// Monotonic (GREATEST) and capped at the database clock; it never touches plan rows.
func applyEntitlementHeartbeat(ctx context.Context, db heartbeatExec, partition int32, emittedAt time.Time) error {
	_, err := db.Exec(ctx, `INSERT INTO entitlement_feed_health(partition_id,verified_at)
   VALUES($1,LEAST($2::timestamptz,clock_timestamp()))
   ON CONFLICT(partition_id) DO UPDATE SET verified_at=GREATEST(entitlement_feed_health.verified_at,excluded.verified_at)`, partition, emittedAt)
	return err
}
func runEntitlementProjector(ctx context.Context, getenv func(string) string) error {
	url, brokers := getenv("TELEMETRY_ENTITLEMENT_PROJECTOR_URL"), getenv("KAFKA_BROKERS")
	if (url == "" && getenv("SHARD_REGISTRY_FILE") == "") || brokers == "" {
		return errors.New("TELEMETRY_ENTITLEMENT_PROJECTOR_URL and KAFKA_BROKERS required")
	}
	var db TxStarter
	if getenv("SHARD_REGISTRY_FILE") != "" {
		shards, err := common.ShardedDBFromEnvironment(getenv, "telemetry-ingest", "greenguard_telemetry", "telemetry_entitlement_projector")
		if err != nil {
			return err
		}
		defer shards.Close()
		db = shards
	} else {
		pool, err := pgxpool.New(ctx, url)
		if err != nil {
			return err
		}
		defer pool.Close()
		db = pool
	}
	options, err := transport.SecureOptions(strings.Split(brokers, ","), "telemetry-entitlements-v1", []string{entitlementTopic}, kgo.FetchIsolationLevel(kgo.ReadCommitted()))
	if err != nil {
		return err
	}
	client, err := kgo.NewClient(options...)
	if err != nil {
		return err
	}
	defer client.CloseAllowingRebalance()
	for ctx.Err() == nil {
		client.AllowRebalance()
		fetches := client.PollRecords(ctx, 1)
		if err := fetches.Err(); err != nil {
			return err
		}
		for _, record := range fetches.Records() {
			if err := processEntitlementRecord(ctx, db, client, record); err != nil {
				return err
			}
		}
	}
	return ctx.Err()
}
