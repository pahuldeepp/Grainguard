package main

import (
	"fmt"
	"sort"
	"time"
)

// canonicalAccumulator retains only projection state, stream versions and
// inventory deltas needed for ordered folding. Kafka event bodies are released
// after validation; telemetry payloads outside the hot window are not retained.
type canonicalAccumulator struct {
	state     referenceState
	seen      map[string]map[int64]bool
	inventory map[string][]referenceEvent
	cutoff    time.Time
}

func newCanonicalAccumulator(cutoff time.Time) *canonicalAccumulator {
	return &canonicalAccumulator{state: newReferenceState(), seen: map[string]map[int64]bool{}, inventory: map[string][]referenceEvent{}, cutoff: cutoff}
}

func (a *canonicalAccumulator) add(e map[string]any) error {
	event, err := parseReferenceEvent(e)
	if err != nil {
		return err
	}
	stream := streamInventory
	if event.Kind == typeTelemetry {
		stream = streamTelemetry
	}
	if err := a.markSeen(event.Device+"/"+stream, event.Version); err != nil {
		return err
	}
	a.state.Notifications[event.Event] = event.Device
	if event.Kind != typeTelemetry {
		a.inventory[event.Device] = append(a.inventory[event.Device], event)
		return nil
	}
	return a.addTelemetry(event)
}

func (a *canonicalAccumulator) versions(key string) map[int64]bool {
	if a.seen[key] == nil {
		a.seen[key] = map[int64]bool{}
	}
	return a.seen[key]
}

func (a *canonicalAccumulator) markSeen(key string, v int64) error {
	versions := a.versions(key)
	if versions[v] {
		return fmt.Errorf("duplicate reference version: %s/%d", key, v)
	}
	versions[v] = true
	return nil
}

func (a *canonicalAccumulator) addTelemetry(event referenceEvent) error {
	p := event.Payload
	a.versions(event.Device + "/" + streamInventory)
	observed, err := parseReferenceTime(p[fieldObservedAt])
	if err != nil {
		return err
	}
	a.selectLatest(event, observed)
	if observed.Before(a.cutoff) {
		return nil
	}
	temperature, humidity, err := referenceMeasurements(p)
	if err != nil {
		return err
	}
	received, err := parseReferenceTime(p["received_at"])
	if err != nil {
		return err
	}
	a.state.Readings[fmt.Sprint(p[fieldReadingID])] = newReferenceReading(event, observed, received, "", temperature, humidity)
	return nil
}

func (a *canonicalAccumulator) selectLatest(event referenceEvent, observed time.Time) {
	latest := a.state.Latest[event.Device]
	previous, parseErr := time.Parse(time.RFC3339Nano, latest.Observed)
	if latest.Reading == "" || parseErr != nil || observed.After(previous) || (observed.Equal(previous) && event.Version > latest.Selected) {
		latest.Reading = fmt.Sprint(event.Payload[fieldReadingID])
		latest.Event = event.Event
		latest.Observed = formatReferenceTime(observed)
		latest.Selected = event.Version
		a.state.Latest[event.Device] = latest
	}
}

func (a *canonicalAccumulator) finish() referenceState {
	for key, versions := range a.seen {
		a.state.Streams[key] = streamFromVersions(versions)
	}
	for device, events := range a.inventory {
		sort.Slice(events, func(i, j int) bool { return events[i].Version < events[j].Version })
		contiguous := a.state.Streams[device+"/"+streamInventory].Contiguous
		if d := foldReferenceDevice(events, contiguous); d.Version > 0 {
			a.state.Devices[device] = d
		}
	}
	for device, l := range a.state.Latest {
		s := a.state.Streams[device+"/"+streamTelemetry]
		l.Max = s.Max
		l.Contiguous = s.Contiguous
		a.state.Latest[device] = l
	}
	for id, r := range a.state.Readings {
		r.Enrichment = enrichmentPending
		if _, ok := a.state.Devices[r.Device]; ok {
			r.Enrichment = enrichmentApplied
		}
		a.state.Readings[id] = r
	}
	return a.state
}

func streamFromVersions(versions map[int64]bool) referenceStream {
	ordered := make([]int64, 0, len(versions))
	for v := range versions {
		ordered = append(ordered, v)
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i] < ordered[j] })
	stream := referenceStream{Gaps: [][2]int64{}}
	previous := int64(0)
	for _, v := range ordered {
		if v > previous+1 {
			stream.Gaps = append(stream.Gaps, [2]int64{previous + 1, v - 1})
		}
		previous = v
	}
	stream.Max = previous
	for versions[stream.Contiguous+1] {
		stream.Contiguous++
	}
	return stream
}
