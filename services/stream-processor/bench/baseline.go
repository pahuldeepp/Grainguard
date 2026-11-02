package main

import (
	"context"
	"crypto/sha1"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"os/signal"
	"sort"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	transport "greenguard.local/kafka-transport"
)

const (
	sizeMs, slideMs = 15 * minute, minute
	boundMs         = 2 * minute
	alpha           = 0.2
	zThreshold      = 4.0
	minSamples      = 30
	cooldownMs      = 5 * minute
	tempRate        = 5.0
	rapidGapMs      = 10 * minute
	relearnAfter    = 10
)

type telemetry struct {
	EventID       string `json:"event_id"`
	TenantID      string `json:"tenant_id"`
	AggregateID   string `json:"aggregate_id"`
	CorrelationID string `json:"correlation_id"`
	Traceparent   string `json:"traceparent"`
	Payload       struct {
		DeviceID     string `json:"device_id"`
		SiteID       string `json:"site_id"`
		ObservedAt   string `json:"observed_at"`
		Measurements struct {
			Temp *float64 `json:"temperature_c"`
			Hum  *float64 `json:"relative_humidity_percent"`
		} `json:"measurements"`
	} `json:"payload"`
}

type acc struct {
	count, tn, hn           int
	tmin, tmax, tsum        float64
	hmin, hmax, hsum        float64
	lastMs                  int64
	lastID, lastCorr, tp    string
	tenant, device, site    string
	revisionFiredPreviously bool
}

type metric struct {
	n           int
	mean, vari  float64
	last        float64
	lastMs      int64
	lastEmit    int64
	consecutive int
}

type device struct {
	seen    map[string]int64
	windows map[int64]*acc
	temp    metric
}

type out struct {
	topic, key string
	value      []byte
}

type state struct {
	devices  map[string]*device
	maxObs   map[int32]int64
	prefix   string
	outputs  []out
	consumed int
}

func uuid5(name string) string {
	h := sha1.Sum([]byte("8c0a3f7e-5a9b-4f43-9d1e-6b2f0c7d4a11|" + name))
	h[6] = h[6]&0x0f | 0x50
	h[8] = h[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", h[0:4], h[4:6], h[6:8], h[8:10], h[10:16])
}

func (s *state) handle(partition int32, e *telemetry) {
	obsT, err := time.Parse(time.RFC3339Nano, e.Payload.ObservedAt)
	if err != nil {
		return
	}
	obs := obsT.UnixMilli()
	key := e.TenantID + ":" + e.AggregateID
	d := s.devices[key]
	if d == nil {
		d = &device{seen: map[string]int64{}, windows: map[int64]*acc{}}
		s.devices[key] = d
	}
	s.consumed++
	if _, dup := d.seen[e.EventID]; dup {
		return
	}
	d.seen[e.EventID] = obs
	if len(d.seen) > 2000 { // bounded, like a state TTL
		for id, t := range d.seen {
			if t < obs-60*minute {
				delete(d.seen, id)
			}
		}
	}
	for start := obs - obs%slideMs; start > obs-sizeMs; start -= slideMs { // the same 15 window updates per event
		a := d.windows[start]
		if a == nil {
			a = &acc{tenant: e.TenantID, device: e.AggregateID, site: e.Payload.SiteID}
			d.windows[start] = a
		}
		a.count++
		if v := e.Payload.Measurements.Temp; v != nil {
			if a.tn == 0 || *v < a.tmin {
				a.tmin = *v
			}
			if a.tn == 0 || *v > a.tmax {
				a.tmax = *v
			}
			a.tsum += *v
			a.tn++
		}
		if v := e.Payload.Measurements.Hum; v != nil {
			if a.hn == 0 || *v < a.hmin {
				a.hmin = *v
			}
			if a.hn == 0 || *v > a.hmax {
				a.hmax = *v
			}
			a.hsum += *v
			a.hn++
		}
		if obs > a.lastMs {
			a.lastMs, a.lastID, a.lastCorr, a.tp = obs, e.EventID, e.CorrelationID, e.Traceparent
		}
	}
	if obs > s.maxObs[partition] {
		s.maxObs[partition] = obs
	}
	if e.Payload.Measurements.Temp != nil {
		s.detect(d, e, obs, *e.Payload.Measurements.Temp)
	}
	wm := s.maxObs[partition] - boundMs - 1
	var due []int64
	for start := range d.windows {
		if start+sizeMs-1 <= wm {
			due = append(due, start)
		}
	}
	sort.Slice(due, func(i, j int) bool { return due[i] < due[j] })
	for _, start := range due {
		s.emitAggregate(key, d.windows[start], start)
		delete(d.windows, start)
	}
}

func (s *state) detect(d *device, e *telemetry, obs int64, v float64) {
	m := &d.temp
	sd := math.Max(math.Sqrt(m.vari), 0.1)
	emitted := false
	cool := func() bool { return m.lastEmit == 0 || obs-m.lastEmit >= cooldownMs }
	if m.n > 0 && obs > m.lastMs {
		gap := obs - m.lastMs
		rate := math.Abs(v-m.last) / (float64(gap) / 60000)
		if gap <= rapidGapMs && rate >= tempRate && cool() {
			s.emitAnomaly(e, obs, "rapid_change", v, m.mean, sd, rate)
			m.lastEmit, emitted = obs, true
		}
	}
	outlier := false
	if m.n >= minSamples {
		z := (v - m.mean) / sd
		outlier = math.Abs(z) >= zThreshold
		if outlier && !emitted && cool() {
			s.emitAnomaly(e, obs, "zscore", v, m.mean, sd, z)
			m.lastEmit = obs
		}
	}
	switch {
	case m.n == 0:
		m.mean, m.vari, m.n = v, 0, 1
	case outlier:
		if m.consecutive++; m.consecutive >= relearnAfter {
			m.mean, m.vari, m.n, m.consecutive = v, 0.01, minSamples, 0
		}
	default:
		m.consecutive = 0
		delta := v - m.mean
		m.mean += alpha * delta
		m.vari = (1 - alpha) * (m.vari + alpha*delta*delta)
		m.n++
	}
	m.last = v
	if obs > m.lastMs {
		m.lastMs = obs
	}
}

func (s *state) emitAnomaly(e *telemetry, obs int64, detector string, v, mean, sd, score float64) {
	body, _ := json.Marshal(map[string]any{"event_id": uuid5("anomaly|" + e.EventID + detector), "event_type": "telemetry.anomaly", "schema_version": 1,
		"occurred_at": iso(obs), "tenant_id": e.TenantID, "aggregate_type": "device_telemetry_stream", "aggregate_id": e.AggregateID,
		"correlation_id": e.CorrelationID, "causation_id": e.EventID, "traceparent": e.Traceparent,
		"payload": map[string]any{"device_id": e.AggregateID, "site_id": e.Payload.SiteID, "bin_id": nil, "metric": "temperature_c", "detector": detector,
			"observed_at": iso(obs), "value": v, "baseline_mean": mean, "baseline_stddev": sd, "score": score, "advisory": true}})
	s.outputs = append(s.outputs, out{s.prefix + ".anomaly", e.TenantID + ":" + e.AggregateID, body})
}

func (s *state) emitAggregate(key string, a *acc, start int64) {
	stats := func(n int, lo, hi, sum float64) any {
		if n == 0 {
			return nil
		}
		return map[string]any{"count": n, "min": lo, "max": hi, "mean": sum / float64(n)}
	}
	body, _ := json.Marshal(map[string]any{"event_id": uuid5(fmt.Sprintf("aggregate|%s|%d", key, start)), "event_type": "telemetry.aggregate", "schema_version": 1,
		"occurred_at": iso(start + sizeMs), "tenant_id": a.tenant, "aggregate_type": "device_telemetry_stream", "aggregate_id": a.device,
		"correlation_id": a.lastCorr, "causation_id": a.lastID, "traceparent": a.tp,
		"payload": map[string]any{"device_id": a.device, "site_id": a.site, "bin_id": nil, "window_start": iso(start), "window_end": iso(start + sizeMs),
			"window_size_seconds": sizeMs / 1000, "slide_seconds": slideMs / 1000, "revision": 1, "reading_count": a.count, "last_observed_at": iso(a.lastMs),
			"temperature_c": stats(a.tn, a.tmin, a.tmax, a.tsum), "relative_humidity_percent": stats(a.hn, a.hmin, a.hmax, a.hsum)}})
	s.outputs = append(s.outputs, out{s.prefix + ".aggregate", key, body})
}

func runBaseline(args []string) error {
	fs := flag.NewFlagSet("baseline", flag.ExitOnError)
	brokers := fs.String("brokers", "kafka:29092", "bootstrap brokers")
	in := fs.String("in", "", "input topic")
	group := fs.String("group", "", "consumer group")
	prefix := fs.String("out-prefix", "", "output topic prefix: <prefix>.aggregate and <prefix>.anomaly")
	mode := fs.String("mode", "batched", "per-record (existing repository style) or batched")
	batch := fs.Int("batch", 1000, "poll size in batched mode")
	fs.Parse(args)
	if *in == "" || *group == "" || *prefix == "" {
		return fmt.Errorf("-in, -group and -out-prefix are required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	opts := transport.Options(splitComma(*brokers), *group, []string{*in}) // the repository's consumer settings: manual commit, acks=all, linger 0
	if *mode == "batched" {
		opts = append(opts, kgo.ProducerLinger(5*time.Millisecond), kgo.ProducerBatchCompression(kgo.Lz4Compression()), kgo.MaxBufferedRecords(100_000))
	}
	cl, err := kgo.NewClient(opts...)
	if err != nil {
		return err
	}
	defer cl.CloseAllowingRebalance()
	s := &state{devices: map[string]*device{}, maxObs: map[int32]int64{}, prefix: *prefix}
	fmt.Println(`{"started":true}`)
	for ctx.Err() == nil {
		if *mode == "per-record" {
			rec, _, err := transport.Next(ctx, cl, fmt.Errorf("offset lost"))
			if err != nil {
				return nil
			}
			var e telemetry
			if json.Unmarshal(rec.Value, &e) == nil {
				s.handle(rec.Partition, &e)
			}
			for _, o := range s.outputs { // synchronous, acks=all, one at a time, like the existing consumers
				if err := transport.Publish(ctx, cl, o.topic, []byte(o.key), o.value, nil); err != nil {
					return err
				}
			}
			s.outputs = s.outputs[:0]
			if err := cl.CommitRecords(ctx, rec); err != nil {
				return err
			}
			continue
		}
		cl.AllowRebalance()
		fetches := cl.PollRecords(ctx, *batch)
		if fetches.IsClientClosed() || ctx.Err() != nil {
			return nil
		}
		var last []*kgo.Record
		fetches.EachPartition(func(p kgo.FetchTopicPartition) {
			for _, rec := range p.Records {
				var e telemetry
				if json.Unmarshal(rec.Value, &e) == nil {
					s.handle(rec.Partition, &e)
				}
			}
			if n := len(p.Records); n > 0 {
				last = append(last, p.Records[n-1])
			}
		})
		for _, o := range s.outputs {
			cl.Produce(ctx, &kgo.Record{Topic: o.topic, Key: []byte(o.key), Value: o.value}, nil)
		}
		s.outputs = s.outputs[:0]
		if err := cl.Flush(ctx); err != nil {
			return err
		}
		if len(last) > 0 {
			if err := cl.CommitRecords(ctx, last...); err != nil {
				return err
			}
		}
	}
	return nil
}

func splitComma(s string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			if i > start {
				out = append(out, s[start:i])
			}
			start = i + 1
		}
	}
	return out
}
