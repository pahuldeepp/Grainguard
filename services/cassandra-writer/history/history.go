// Package history owns the Cassandra reading-history tables. Cassandra has no
// row-level security, so every statement here keys on tenant_id in the
// partition key and no exported function accepts a tenant-less query.
package history

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"time"
)

// Consistency mirrors the CQL levels this package uses, so callers and fakes
// do not depend on the driver.
type Consistency int

const (
	// LocalQuorum is the write and read level: ONE on the local RF1 profile,
	// two of three replicas on the resilient RF3 profile.
	LocalQuorum Consistency = iota + 1
)

// Rows is the subset of a driver iterator the reader needs.
type Rows interface {
	Scan(dest ...any) bool
	Close() error
}

// Session is the driver seam; production wraps gocql, tests use a fake.
type Session interface {
	Exec(ctx context.Context, level Consistency, stmt string, args ...any) error
	Iter(ctx context.Context, level Consistency, stmt string, args ...any) Rows
}

// Reading is one history row.
type Reading struct {
	TenantID, DeviceID, ReadingID, EventID, SiteID, BinID string
	ObservedAt, ReceivedAt                                time.Time
	StreamVersion                                         int64
	TemperatureC, RelativeHumidityPercent                 *float64
}

// Watermark records the last acknowledged history write for one device and
// source partition.
type Watermark struct {
	TenantID, DeviceID, Topic string
	Partition                 int32
	Offset                    int64
	ObservedAt                time.Time
}

// Result carries rows plus freshness and truncation metadata for callers.
type Result struct {
	Readings  []Reading
	Truncated bool
	Source    string
}

var (
	ErrInvalidTenant = errors.New("history query requires a lowercase, non-nil tenant UUID")
	ErrInvalidDevice = errors.New("history query requires a lowercase, non-nil device UUID")
	ErrInvalidRange  = errors.New("history range must have from <= to and span at most MaxDays")
)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// ValidID reports whether id is a lowercase, versioned UUID.
func ValidID(id string) bool { return uuidPattern.MatchString(id) }

const (
	insertReading = `INSERT INTO readings_by_device_day (tenant_id, device_id, day, observed_at, reading_id, event_id, stream_version, received_at, site_id, bin_id, temperature_c, relative_humidity_percent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) USING TTL ?`
	selectDay     = `SELECT tenant_id, device_id, observed_at, reading_id, event_id, stream_version, received_at, site_id, bin_id, temperature_c, relative_humidity_percent FROM readings_by_device_day WHERE tenant_id = ? AND device_id = ? AND day = ? AND observed_at >= ? AND observed_at <= ?`
	upsertMark    = `INSERT INTO history_watermark (tenant_id, device_id, source_topic, source_partition, last_confirmed_offset, last_confirmed_observed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
	selectMark    = `SELECT last_confirmed_offset, last_confirmed_observed_at FROM history_watermark WHERE tenant_id = ? AND device_id = ? AND source_topic = ? AND source_partition = ?`
	day           = 24 * time.Hour
)

// Store writes and reads history through a Session.
type Store struct {
	Session Session
	TTL     time.Duration
	MaxRows int
	MaxDays int
	Now     func() time.Time
}

// Day is the UTC calendar bucket for an observation time; late readings land
// in their own observed day, not the day they arrived.
func Day(t time.Time) time.Time { return t.UTC().Truncate(day) }

// Write upserts one reading keyed by its full primary key, so duplicate or
// replayed deliveries overwrite identical values.
func (s *Store) Write(ctx context.Context, r Reading) error {
	if !ValidID(r.TenantID) {
		return ErrInvalidTenant
	}
	return s.Session.Exec(ctx, LocalQuorum, insertReading, r.TenantID, r.DeviceID, Day(r.ObservedAt), r.ObservedAt.UTC(), r.ReadingID, r.EventID, r.StreamVersion, r.ReceivedAt.UTC(), r.SiteID, r.BinID, r.TemperatureC, r.RelativeHumidityPercent, int(s.TTL.Seconds()))
}

// Confirm upserts the watermark after the history write was acknowledged. A
// replay after a rewind may move it backwards; that is conservative for any
// later deletion that relies on it.
func (s *Store) Confirm(ctx context.Context, w Watermark) error {
	if !ValidID(w.TenantID) {
		return ErrInvalidTenant
	}
	return s.Session.Exec(ctx, LocalQuorum, upsertMark, w.TenantID, w.DeviceID, w.Topic, int(w.Partition), w.Offset, w.ObservedAt.UTC(), s.now().UTC())
}

// ReadWatermark returns the confirmed watermark for one device and partition.
func (s *Store) ReadWatermark(ctx context.Context, tenant, device, topic string, partition int32) (Watermark, bool, error) {
	if !ValidID(tenant) {
		return Watermark{}, false, ErrInvalidTenant
	}
	w := Watermark{TenantID: tenant, DeviceID: device, Topic: topic, Partition: partition}
	rows := s.Session.Iter(ctx, LocalQuorum, selectMark, tenant, device, topic, int(partition))
	found := rows.Scan(&w.Offset, &w.ObservedAt)
	return w, found, rows.Close()
}

// Query returns one tenant's device history in [from, to], newest first. The
// tenant argument is mandatory and becomes part of every partition key read.
func (s *Store) Query(ctx context.Context, tenant, device string, from, to time.Time) (Result, error) {
	if !ValidID(tenant) {
		return Result{}, ErrInvalidTenant
	}
	if !ValidID(device) {
		return Result{}, ErrInvalidDevice
	}
	if from.After(to) || Day(to).Sub(Day(from)) >= time.Duration(s.MaxDays)*day {
		return Result{}, ErrInvalidRange
	}
	result := Result{Source: SourceCassandra}
	for bucket := Day(to); !bucket.Before(Day(from)); bucket = bucket.Add(-day) {
		full, err := s.readDay(ctx, &result, tenant, device, bucket, from, to)
		if err != nil || full {
			return result, err
		}
	}
	return result, nil
}

func (s *Store) readDay(ctx context.Context, result *Result, tenant, device string, bucket, from, to time.Time) (bool, error) {
	rows := s.Session.Iter(ctx, LocalQuorum, selectDay, tenant, device, bucket, from.UTC(), to.UTC())
	for {
		var r Reading
		if !rows.Scan(&r.TenantID, &r.DeviceID, &r.ObservedAt, &r.ReadingID, &r.EventID, &r.StreamVersion, &r.ReceivedAt, &r.SiteID, &r.BinID, &r.TemperatureC, &r.RelativeHumidityPercent) {
			return false, rows.Close()
		}
		if len(result.Readings) == s.MaxRows {
			result.Truncated = true
			return true, rows.Close()
		}
		result.Readings = append(result.Readings, r)
	}
}

func (s *Store) now() time.Time {
	if s.Now == nil {
		return time.Now()
	}
	return s.Now()
}

// Sources named in Result.Source.
const (
	SourceCassandra = "cassandra"
	SourcePostgres  = "postgres"
	SourceMerged    = "merged"
)

// Range is a closed time interval.
type Range struct{ From, To time.Time }

// Split divides [from, to] at now-hotWindow: the hot part is served by
// Postgres reading_history, the cold part by Cassandra. Either may be nil.
func Split(now time.Time, hotWindow time.Duration, from, to time.Time) (cold, hot *Range) {
	boundary := now.Add(-hotWindow)
	if !to.Before(boundary) {
		hot = &Range{From: maxTime(from, boundary), To: to}
	}
	if from.Before(boundary) {
		cold = &Range{From: from, To: minTime(to, boundary)}
	}
	return cold, hot
}

// Merge combines both stores' results newest first, de-duplicating by
// reading ID so a reading present on both sides of the boundary appears once.
func Merge(cold, hot Result) Result {
	seen := make(map[string]bool, len(cold.Readings)+len(hot.Readings))
	out := Result{Source: SourceMerged, Truncated: cold.Truncated || hot.Truncated}
	for _, r := range append(append([]Reading{}, hot.Readings...), cold.Readings...) {
		if !seen[r.ReadingID] {
			seen[r.ReadingID] = true
			out.Readings = append(out.Readings, r)
		}
	}
	sort.SliceStable(out.Readings, func(i, j int) bool { return out.Readings[i].ObservedAt.After(out.Readings[j].ObservedAt) })
	return out
}

// HotWindow reads HISTORY_HOT_WINDOW, shared with Postgres reading_history.
func HotWindow(getenv func(string) string) (time.Duration, error) {
	return positiveDuration(getenv("HISTORY_HOT_WINDOW"), 24*time.Hour)
}

// TTL reads HISTORY_TTL (a Go duration), defaulting to 365 days.
func TTL(getenv func(string) string) (time.Duration, error) {
	ttl, err := positiveDuration(getenv("HISTORY_TTL"), 365*day)
	if err == nil && ttl < time.Second {
		err = errors.New("HISTORY_TTL must be at least one second")
	}
	if err == nil && ttl/time.Second > 630720000 {
		err = errors.New("HISTORY_TTL exceeds Cassandra's 630720000-second limit")
	}
	return ttl, err
}

func positiveDuration(text string, fallback time.Duration) (time.Duration, error) {
	if text == "" {
		return fallback, nil
	}
	d, err := time.ParseDuration(text)
	if err != nil || d <= 0 {
		return 0, errors.New("duration must be a positive Go duration such as 24h")
	}
	return d, nil
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
