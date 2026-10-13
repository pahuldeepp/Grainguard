package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"math"
	"strconv"
)

const sensorLayoutTopic = "greenguard.inventory.sensor-layout.v1"
const eventCableLayout = "cable.layout_changed"
const sensorLayoutConsumer = "sensor-layout"

type layoutSensor struct {
	SensorID string   `json:"sensor_id"`
	Position int      `json:"position"`
	Label    string   `json:"label"`
	DepthM   *float64 `json:"depth_m"`
}

type layoutEvent struct {
	EventID          string `json:"event_id"`
	EventType        string `json:"event_type"`
	TenantID         string `json:"tenant_id"`
	SchemaVersion    int    `json:"schema_version"`
	AggregateType    string `json:"aggregate_type"`
	AggregateID      string `json:"aggregate_id"`
	AggregateVersion string `json:"aggregate_version"`
	Payload          struct {
		CableID      string         `json:"cable_id"`
		DeviceID     string         `json:"device_id"`
		BinID        *string        `json:"bin_id"`
		CableVersion string         `json:"cable_version"`
		Operation    string         `json:"operation"`
		Sensors      []layoutSensor `json:"sensors"`
	} `json:"payload"`
}

func parseLayoutEvent(data []byte) (layoutEvent, int64, error) {
	var e layoutEvent
	if json.Unmarshal(data, &e) != nil {
		return e, 0, ErrInvalidEvent
	}
	version, err := strconv.ParseInt(e.AggregateVersion, 10, 64)
	if err != nil || version < 1 || !versionPattern.MatchString(e.AggregateVersion) || e.Payload.CableVersion != e.AggregateVersion {
		return e, 0, ErrInvalidEvent
	}
	if e.EventType != eventCableLayout || e.SchemaVersion != 1 || e.AggregateType != "cable" || e.Payload.CableID != e.AggregateID {
		return e, 0, ErrInvalidEvent
	}
	for _, id := range []string{e.EventID, e.TenantID, e.AggregateID, e.Payload.DeviceID} {
		if !isUUID(id) {
			return e, 0, ErrInvalidEvent
		}
	}
	if e.Payload.BinID == nil || !isUUID(*e.Payload.BinID) {
		return e, 0, ErrInvalidEvent
	}
	if err := validateLayoutSensors(e); err != nil {
		return e, 0, err
	}
	return e, version, nil
}

func validateLayoutSensors(e layoutEvent) error {
	if e.Payload.Operation != "upsert" && e.Payload.Operation != "deleted" {
		return ErrInvalidEvent
	}
	if len(e.Payload.Sensors) > 100 || (e.Payload.Operation == "deleted" && len(e.Payload.Sensors) > 0) {
		return ErrInvalidEvent
	}
	ids := map[string]bool{}
	positions := map[int]bool{}
	for _, s := range e.Payload.Sensors {
		if !isUUID(s.SensorID) || ids[s.SensorID] || s.Position < 1 || s.Position > 100 || positions[s.Position] {
			return ErrInvalidEvent
		}
		ids[s.SensorID], positions[s.Position] = true, true
		if s.DepthM != nil && (math.IsNaN(*s.DepthM) || math.IsInf(*s.DepthM, 0) || *s.DepthM < 0) {
			return ErrInvalidEvent
		}
	}
	return nil
}

func layoutReason(m BindingMessage) string {
	e, _, err := parseLayoutEvent(m.Value)
	if err != nil {
		return reasonSchema
	}
	if string(m.Key) != e.TenantID+":"+e.AggregateID {
		return reasonKey
	}
	return ""
}

// ApplyLayoutEvent atomically receipts and replaces an owner snapshot. Versions
// fence stale deliveries; a sequence gap holds the offset for repair.
func ApplyLayoutEvent(ctx context.Context, db TxStarter, data []byte) (BindingOutcome, error) {
	e, version, err := parseLayoutEvent(data)
	if err != nil {
		return "", err
	}
	outcome := BindingApplied
	err = WithTenant(ctx, db, e.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `WITH lock AS (SELECT pg_advisory_xact_lock(hashtextextended($2::text || ':cable:' || $5::text,0)))
 INSERT INTO consumer_inbox(consumer_name,tenant_id,event_id,event)
 SELECT $1,$2::uuid,$3::uuid,$4::jsonb FROM lock ON CONFLICT DO NOTHING`, sensorLayoutConsumer, e.TenantID, e.EventID, string(data), e.AggregateID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			var same bool
			if err := tx.QueryRow(ctx, `SELECT event=$4::jsonb FROM consumer_inbox WHERE consumer_name=$1 AND tenant_id=$2 AND event_id=$3`, sensorLayoutConsumer, e.TenantID, e.EventID, string(data)).Scan(&same); err != nil {
				return err
			}
			if !same {
				return ErrEventConflict
			}
			outcome = BindingDuplicate
			return nil
		}
		outcome, err = replaceLayout(ctx, tx, e, version)
		return err
	})
	if err != nil {
		return "", err
	}
	return outcome, nil
}

func replaceLayout(ctx context.Context, tx pgx.Tx, e layoutEvent, version int64) (BindingOutcome, error) {
	var current int64
	err := tx.QueryRow(ctx, `SELECT layout_version FROM cable_layout_bindings WHERE tenant_id=$1 AND cable_id=$2 FOR UPDATE`, e.TenantID, e.AggregateID).Scan(&current)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if version <= current {
		return BindingStale, nil
	}
	if version != current+1 {
		return "", ErrVersionGap
	}
	sensors, _ := json.Marshal(e.Payload.Sensors)
	_, err = tx.Exec(ctx, `INSERT INTO cable_layout_bindings(tenant_id,cable_id,device_id,bin_id,layout_version,deleted,sensors)
 VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(tenant_id,cable_id) DO UPDATE
 SET device_id=EXCLUDED.device_id,bin_id=EXCLUDED.bin_id,layout_version=EXCLUDED.layout_version,deleted=EXCLUDED.deleted,sensors=EXCLUDED.sensors`, e.TenantID, e.AggregateID, e.Payload.DeviceID, e.Payload.BinID, version, e.Payload.Operation == "deleted", string(sensors))
	return BindingApplied, err
}
