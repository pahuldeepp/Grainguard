package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
)

func (r ReadingRequest) measurements() measurementsJSON {
	return measurementsJSON{TemperatureC: r.TemperatureC, RelativeHumidityPercent: r.RelativeHumidityPercent, CO2PPM: r.CO2PPM, GrainMoisturePercent: r.GrainMoisturePercent}
}

type SensorLayout struct {
	CableID, LayoutVersion string
	Position               int
	DepthM                 *float64
}

// SensorResolver must resolve inside the tenant transaction. The local owner feed
// is the production implementation; the request never declares its own association.
type SensorResolver func(context.Context, pgx.Tx, string, string, *string, string) (SensorLayout, error)

func resolveSensorObservations(ctx context.Context, tx pgx.Tx, a *attempt, b storedBinding) error {
	for index := range a.req.SensorObservations {
		sample := &a.req.SensorObservations[index]
		if a.sensors == nil {
			return newRejection(ReasonSensorForbidden, statusForbidden, "sensor inventory is unavailable")
		}
		layout, err := a.sensors(ctx, tx, a.principal.TenantID, a.deviceID, b.binID, sample.SensorID)
		if err != nil {
			return err
		}
		sample.CableID, sample.LayoutVersion, sample.Position, sample.DepthM = layout.CableID, layout.LayoutVersion, layout.Position, layout.DepthM
	}
	return nil
}

func resolveLocalSensor(ctx context.Context, tx pgx.Tx, tenant, device string, bin *string, sensor string) (SensorLayout, error) {
	var layout SensorLayout
	var matches int
	err := tx.QueryRow(ctx, `WITH matches AS (SELECT c.cable_id::text AS cable_id, c.layout_version::text AS layout_version, (s->>'position')::integer AS position, (s->>'depth_m')::double precision AS depth_m
 FROM cable_layout_bindings c CROSS JOIN LATERAL jsonb_array_elements(c.sensors) s
 WHERE c.tenant_id = $1 AND c.device_id = $2 AND c.bin_id IS NOT DISTINCT FROM $3::uuid
 AND NOT c.deleted AND s->>'sensor_id' = $4 FOR SHARE OF c) SELECT cable_id,layout_version,position,depth_m,count(*) OVER() FROM matches`, tenant, device, bin, sensor).Scan(&layout.CableID, &layout.LayoutVersion, &layout.Position, &layout.DepthM, &matches)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && matches != 1) {
		return layout, newRejection(ReasonSensorForbidden, statusForbidden, "sensor is not active for this tenant, device and bin")
	}
	if err != nil {
		return layout, fmt.Errorf("resolve sensor layout: %w", err)
	}
	return layout, nil
}

func insertReadingV2(ctx context.Context, tx pgx.Tx, r record) error {
	samples := "[]"
	if len(r.req.SensorObservations) > 0 {
		data, _ := json.Marshal(r.req.SensorObservations)
		samples = string(data)
	}
	units, _ := json.Marshal(r.req.MeasurementUnits)
	_, err := tx.Exec(ctx, `INSERT INTO readings (tenant_id, reading_id, device_id, stream_version, source_message_id, site_id, bin_id,
 binding_version, observed_at, received_at, temperature_c, relative_humidity_percent, co2_ppm, grain_moisture_percent, measurement_units, sensor_observations, schema_version)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,2)`, r.principal.TenantID, r.readingID, r.deviceID, r.version, r.req.SourceMessageID, r.binding.siteID, r.binding.binID, r.binding.version, r.req.ObservedAt, r.now, r.req.TemperatureC, r.req.RelativeHumidityPercent, r.req.CO2PPM, r.req.GrainMoisturePercent, string(units), samples)
	return err
}

func insertOutboxV2(ctx context.Context, tx pgx.Tx, r record) error {
	_, err := tx.Exec(ctx, `INSERT INTO outbox_events (event_id, tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type,
 schema_version, occurred_at, correlation_id, causation_id, traceparent, payload)
 VALUES ($1,$2,$3,$4,$5,$6,2,$7,$8,$9,$10,$11::jsonb)`, r.eventID, r.principal.TenantID, aggregateTelemetryStream, r.deviceID, r.version, eventTypeTelemetryRecorded, r.now, r.meta.CorrelationID, r.commandID, r.meta.Traceparent, r.payloadJSON())
	return err
}
