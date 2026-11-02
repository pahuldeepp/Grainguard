package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

const t0 = int64(1_767_225_600_000) // 2026-01-01T00:00:00Z
const minute = int64(60_000)

func uid(n int64) string  { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) }
func iso(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z") }

func event(tenant, device, id string, observed, sent int64, temp float64) (string, string) {
	key := tenant + ":" + device
	value := fmt.Sprintf(`{"event_id":"%s","event_type":"telemetry.recorded","schema_version":1,"occurred_at":"%s","tenant_id":"%s","aggregate_type":"device_telemetry_stream","aggregate_id":"%s","aggregate_version":"1","correlation_id":"%s","causation_id":"%s","traceparent":"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01","payload":{"reading_id":"%s","device_id":"%s","site_id":"%s","bin_id":null,"binding_version":"1","source_message_id":"s-%s","observed_at":"%s","received_at":"%s","measurements":{"temperature_c":%.2f,"relative_humidity_percent":50.0}}}`,
		id, iso(observed), tenant, device, uid(7), uid(8), id, device, uid(10), id, iso(observed), iso(sent), temp)
	return key, value
}

func runGen(args []string) error {
	fs := flag.NewFlagSet("gen", flag.ExitOnError)
	brokers := fs.String("brokers", "127.0.0.1:59192", "bootstrap brokers")
	topic := fs.String("topic", "", "input topic")
	devices := fs.Int("devices", 600, "devices")
	readings := fs.Int("readings", 100, "readings per device (one per event-time minute)")
	tenants := fs.Int("tenants", 5, "tenants")
	rate := fs.Int("rate", 0, "events per second (0 = as fast as possible)")
	spikes := fs.String("spike-out", "", "write event_id -> produce time (ms) for injected spikes as JSON")
	salt := fs.Int64("salt", 1, "run salt so event IDs are unique")
	realtime := fs.Bool("realtime", false, "observed_at follows the wall clock (latency test) instead of one event-time minute per reading")
	duration := fs.Duration("duration", 60*time.Second, "realtime mode: how long to send")
	spikeAfter := fs.Duration("spike-at", 30*time.Second, "realtime mode: when every tenth device spikes by +12C")
	fs.Parse(args)
	if *topic == "" {
		return fmt.Errorf("-topic required")
	}
	cl, err := kgo.NewClient(kgo.SeedBrokers(*brokers), kgo.ProducerBatchMaxBytes(1<<20), kgo.ProducerLinger(5*time.Millisecond),
		kgo.ProducerBatchCompression(kgo.Lz4Compression()), kgo.MaxBufferedRecords(200_000))
	if err != nil {
		return err
	}
	defer cl.Close()
	ctx := context.Background()
	spikeTimes := map[string]int64{}
	var failed error
	produced := 0
	start := time.Now()
	send := func(key, value string) {
		cl.Produce(ctx, &kgo.Record{Topic: *topic, Key: []byte(key), Value: []byte(value)}, func(_ *kgo.Record, e error) {
			if e != nil && failed == nil {
				failed = e
			}
		})
		produced++
		if *rate > 0 && produced%100 == 0 {
			target := time.Duration(float64(produced) / float64(*rate) * float64(time.Second))
			if d := target - time.Since(start); d > 0 {
				time.Sleep(d)
			}
		}
	}
	if *realtime {
		return realtimeLoop(cl, *topic, *devices, *tenants, *rate, *duration, *spikeAfter, *salt, *spikes)
	}
	spikeAt := *readings / 2
	for k := 0; k < *readings; k++ {
		for d := 0; d < *devices; d++ {
			tenant, device := uid(*salt*1_000_000+int64(d%*tenants)), uid(*salt*1_000_000+1000+int64(d))
			id := uid(*salt*100_000_000 + int64(k)*int64(*devices) + int64(d) + 1)
			temp := 20.0 + float64(k%2)*0.05
			if d%10 == 0 && k == spikeAt {
				temp += 12
				spikeTimes[id] = time.Now().UnixMilli()
			}
			key, value := event(tenant, device, id, t0+int64(k)*minute, time.Now().UnixMilli(), temp)
			send(key, value)
		}
	}
	// one far-future reading per device advances every partition's watermark so all earlier windows close
	for d := 0; d < *devices; d++ {
		tenant, device := uid(*salt*1_000_000+int64(d%*tenants)), uid(*salt*1_000_000+1000+int64(d))
		id := uid(*salt*100_000_000 + int64(*readings)*int64(*devices) + int64(d) + 1)
		key, value := event(tenant, device, id, t0+int64(*readings+1000)*minute, time.Now().UnixMilli(), 20)
		send(key, value)
	}
	if err := cl.Flush(ctx); err != nil {
		return err
	}
	if failed != nil {
		return failed
	}
	if *spikes != "" {
		b, _ := json.Marshal(spikeTimes)
		if err := os.WriteFile(*spikes, b, 0o644); err != nil {
			return err
		}
	}
	summary := map[string]any{"events": produced, "devices": *devices, "readings": *readings, "seconds": time.Since(start).Seconds(),
		"expectedAggregates": *devices * (*readings + 14), "expectedAnomalies": (*devices + 9) / 10}
	out, _ := json.Marshal(summary)
	fmt.Println(string(out))
	return nil
}

// realtimeLoop sends round-robin readings whose event time is the wall clock, so end-to-end latency includes
// any event-time buffering (watermark bound) exactly as production traffic would see it.
func realtimeLoop(cl *kgo.Client, topic string, devices, tenants, rate int, duration, spikeAfter time.Duration, salt int64, spikeOut string) error {
	ctx := context.Background()
	spikeTimes := map[string]int64{}
	spiked := make([]bool, devices)
	start := time.Now()
	n := int64(0)
	for time.Since(start) < duration {
		for d := 0; d < devices && time.Since(start) < duration; d++ {
			now := time.Now().UnixMilli()
			tenant, device := uid(salt*1_000_000+int64(d%tenants)), uid(salt*1_000_000+1000+int64(d))
			n++
			id := uid(salt*100_000_000 + n)
			temp := 20.0 + float64(n%2)*0.05
			if d%10 == 0 && !spiked[d] && time.Since(start) >= spikeAfter {
				spiked[d] = true
				temp += 12
				spikeTimes[id] = now
			}
			key, value := event(tenant, device, id, now, now, temp)
			cl.Produce(ctx, &kgo.Record{Topic: topic, Key: []byte(key), Value: []byte(value), Timestamp: time.UnixMilli(now)}, nil)
			if rate > 0 && n%100 == 0 {
				if wait := time.Duration(float64(n)/float64(rate)*float64(time.Second)) - time.Since(start); wait > 0 {
					time.Sleep(wait)
				}
			}
		}
	}
	if err := cl.Flush(ctx); err != nil {
		return err
	}
	if spikeOut != "" {
		b, _ := json.Marshal(spikeTimes)
		if err := os.WriteFile(spikeOut, b, 0o644); err != nil {
			return err
		}
	}
	out, _ := json.Marshal(map[string]any{"events": n, "devices": devices, "seconds": time.Since(start).Seconds(), "spikes": len(spikeTimes)})
	fmt.Println(string(out))
	return nil
}
