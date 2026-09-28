package main

import (
	"encoding/json"
	common "greenguard.local/go-common"
	"math"
	"sort"
)

const fieldCO2 = "co2_ppm"
const fieldGrainMoisture = "grain_moisture_percent"

// SensorObservation carries stable sample identity and owner-derived layout provenance.
// Input requests may supply only the first four fields.
type SensorObservation struct {
	SensorID      string   `json:"sensor_id"`
	Metric        string   `json:"metric"`
	Value         float64  `json:"value"`
	Unit          string   `json:"unit"`
	LayoutVersion string   `json:"layout_version,omitempty"`
	CableID       string   `json:"cable_id,omitempty"`
	Position      int      `json:"position,omitempty"`
	DepthM        *float64 `json:"depth_m"`
}

var v2Fields = map[string]bool{
	"schema_version": true, fieldSourceMessageID: true, fieldObservedAt: true,
	fieldTemperature: true, fieldHumidity: true, fieldCO2: true, fieldGrainMoisture: true,
	"measurement_units": true, "sensor_observations": true,
}

func parseV2Measurements(fields map[string]any, req *ReadingRequest) *Rejection {
	req.SchemaVersion = 2
	req.MeasurementUnits = map[string]string{}
	units, ok := fields["measurement_units"].(map[string]any)
	if !ok {
		return newRejection(ReasonInvalidField, statusBadRequest, "measurement_units must be an object")
	}
	targets := map[string]**float64{fieldTemperature: &req.TemperatureC, fieldHumidity: &req.RelativeHumidityPercent, fieldCO2: &req.CO2PPM, fieldGrainMoisture: &req.GrainMoisturePercent}
	for metric, target := range targets {
		value, rej := parseMeasurement(fields, metric)
		if rej != nil {
			return rej
		}
		*target = value
		if value != nil {
			if units[metric] != common.TelemetryUnits[metric] {
				return newRejection(ReasonInvalidField, statusBadRequest, "each measurement requires its physical unit")
			}
			req.MeasurementUnits[metric] = common.TelemetryUnits[metric]
			if rej := checkMetricRange(metric, value); rej != nil {
				return rej
			}
		}
	}
	if len(units) != len(req.MeasurementUnits) {
		return newRejection(ReasonInvalidField, statusBadRequest, "units must describe only actual measurements")
	}
	samples, rej := parseSensorSamples(fields["sensor_observations"])
	if rej != nil {
		return rej
	}
	req.SensorObservations = samples
	if len(req.MeasurementUnits) == 0 && len(samples) == 0 {
		return newRejection(ReasonNoMeasurements, statusUnprocessable, "at least one actual measurement is required")
	}
	return nil
}

func checkMetricRange(metric string, value *float64) *Rejection {
	switch metric {
	case fieldTemperature:
		return checkRange(metric, value, -80, 120)
	case fieldCO2:
		return checkRange(metric, value, 0, math.Inf(1))
	default:
		return checkRange(metric, value, 0, 100)
	}
}

func parseSensorSamples(raw any) ([]SensorObservation, *Rejection) {
	if raw == nil {
		return nil, nil
	}
	values, ok := raw.([]any)
	if !ok || len(values) == 0 || len(values) > 256 {
		return nil, newRejection(ReasonInvalidField, statusBadRequest, "sensor_observations requires 1-256 observations")
	}
	result := make([]SensorObservation, 0, len(values))
	seen := map[string]bool{}
	for _, raw := range values {
		sample, rej := parseSensorSample(raw)
		if rej != nil {
			return nil, rej
		}
		key := sample.SensorID + ":" + sample.Metric
		if seen[key] {
			return nil, newRejection(ReasonInvalidField, statusBadRequest, "duplicate sensor/metric identity")
		}
		seen[key] = true
		result = append(result, sample)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].SensorID+":"+result[i].Metric < result[j].SensorID+":"+result[j].Metric
	})
	return result, nil
}

func parseSensorSample(raw any) (SensorObservation, *Rejection) {
	fields, ok := raw.(map[string]any)
	if !ok || len(fields) != 4 {
		return SensorObservation{}, newRejection(ReasonInvalidField, statusBadRequest, "sensor observation requires sensor_id, metric, value and unit")
	}
	id, _ := fields["sensor_id"].(string)
	metric, _ := fields["metric"].(string)
	unit, _ := fields["unit"].(string)
	if !isUUID(id) || common.TelemetryUnits[metric] == "" || unit != common.TelemetryUnits[metric] {
		return SensorObservation{}, newRejection(ReasonInvalidField, statusBadRequest, "invalid sensor identity, metric or unit")
	}
	if _, ok := fields["value"].(json.Number); !ok {
		return SensorObservation{}, newRejection(ReasonInvalidField, statusBadRequest, "sensor value must be a number")
	}
	value, rej := parseMeasurement(fields, "value")
	if rej != nil {
		return SensorObservation{}, rej
	}
	if rej := checkMetricRange(metric, value); rej != nil {
		return SensorObservation{}, rej
	}
	return SensorObservation{SensorID: id, Metric: metric, Value: *value, Unit: unit}, nil
}
