package common

import (
	"encoding/json"
	"errors"
	"math"
)

// TelemetryUnits names physical units; these are acceptance rules, not calibrated limits.
var TelemetryUnits = map[string]string{
	"temperature_c": "Cel", "relative_humidity_percent": "%", "co2_ppm": "ppm", "grain_moisture_percent": "%",
}

func FiniteNumber(value any) bool {
	var f float64
	switch v := value.(type) {
	case json.Number:
		n, err := v.Float64()
		if err != nil {
			return false
		}
		f = n
	case float64:
		f = v
	default:
		return false
	}
	return !math.IsNaN(f) && !math.IsInf(f, 0)
}

// ValidateTelemetryV2 supplements the JSON Schema with cross-field and finite-number rules.
// Call only after schema validation; association authorization remains the producer's duty.
func ValidateTelemetryV2(payload map[string]any) error {
	measurements, _ := payload["measurements"].(map[string]any)
	units, _ := payload["measurement_units"].(map[string]any)
	if len(measurements) != len(units) {
		return errors.New("measurement units must match actual measurements")
	}
	for metric, value := range measurements {
		if !FiniteNumber(value) || units[metric] != TelemetryUnits[metric] {
			return errors.New("measurement must be finite and carry its physical unit")
		}
	}
	seen := map[string]bool{}
	observations, _ := payload["sensor_observations"].([]any)
	for _, raw := range observations {
		observation := raw.(map[string]any)
		sensor, _ := observation["sensor_id"].(string)
		metric, _ := observation["metric"].(string)
		identity := sensor + ":" + metric
		if seen[identity] || sensor == "00000000-0000-0000-0000-000000000000" || observation["cable_id"] == "00000000-0000-0000-0000-000000000000" {
			return errors.New("sensor/metric identities must be unique and non-nil")
		}
		seen[identity] = true
		if !FiniteNumber(observation["value"]) || observation["unit"] != TelemetryUnits[metric] {
			return errors.New("sensor measurement must be finite and carry its physical unit")
		}
		if depth := observation["depth_m"]; depth != nil && !FiniteNumber(depth) {
			return errors.New("depth must be finite")
		}
		if _, err := Bigint(observation["layout_version"]); err != nil {
			return err
		}
	}
	return nil
}

// ValidateCableLayout checks owner snapshot identities after schema validation.
func ValidateCableLayout(payload map[string]any) error {
	for _, field := range []string{"device_id", "bin_id", "cable_id"} {
		if payload[field] == "00000000-0000-0000-0000-000000000000" {
			return errors.New("layout identities must not be nil")
		}
	}
	if _, err := Bigint(payload["cable_version"]); err != nil {
		return err
	}
	ids := map[string]bool{}
	positions := map[float64]bool{}
	sensors, _ := payload["sensors"].([]any)
	for _, raw := range sensors {
		sensor := raw.(map[string]any)
		id, _ := sensor["sensor_id"].(string)
		var key float64
		switch position := sensor["position"].(type) {
		case json.Number:
			key, _ = position.Float64()
		case float64:
			key = position
		default:
			return errors.New("position must be numeric")
		}
		if ids[id] || positions[key] || id == "00000000-0000-0000-0000-000000000000" {
			return errors.New("sensor identities and positions must be unique and non-nil")
		}
		ids[id], positions[key] = true, true
		if depth := sensor["depth_m"]; depth != nil && !FiniteNumber(depth) {
			return errors.New("depth must be finite")
		}
	}
	return nil
}
