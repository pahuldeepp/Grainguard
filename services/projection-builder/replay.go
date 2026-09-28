package main

// Replay deliberately targets a separate database. It never truncates a live
// inbox, changes live group offsets, or promotes an unverified projection.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/kmsg"
	common "greenguard.local/go-common"
	transport "greenguard.local/kafka-transport"
	"greenguard.local/projection-builder/history"
)

const replayConsumer = "projection-builder-replay"

var replayDatabasePattern = regexp.MustCompile(`^greenguard_read_replay_[a-z0-9_]{1,40}$`)

type replayPartition struct {
	Topic     string   `json:"topic"`
	Partition int32    `json:"partition"`
	TopicID   [16]byte `json:"-"`
	Start     int64    `json:"retained_start"`
	End       int64    `json:"snapshot_end"`
	Next      int64    `json:"next_offset"`
}

type replayRunner struct {
	Client        *kgo.Client
	Store         *Store
	Validator     *Processor
	Tenant, Group string
	RecordTenant  func(context.Context, string) error
	Save          func(context.Context, replayPartition) error
	Apply         func(context.Context, Message, map[string]any) error
}

// replayBounds captures a finite frontier. Retention is checked again on every
// restart, and NoResetOffset fails closed if records expire during the run.
func replayBounds(ctx context.Context, client *kgo.Client) ([]replayPartition, error) {
	result, err := replayMetadata(ctx, client)
	if err != nil {
		return nil, err
	}
	for _, timestamp := range []int64{-2, -1} {
		if err := fillReplayOffsets(ctx, client, result, timestamp); err != nil {
			return nil, err
		}
	}
	return result, nil
}

var replayTopics = projectionTopics

func replayMetadata(ctx context.Context, client *kgo.Client) ([]replayPartition, error) {
	req := kmsg.NewPtrMetadataRequest()
	req.AllowAutoTopicCreation = false
	for _, topic := range replayTopics {
		req.Topics = append(req.Topics, kmsg.MetadataRequestTopic{Topic: kmsg.StringPtr(topic)})
	}
	meta, err := req.RequestWith(ctx, client)
	if err != nil {
		return nil, err
	}
	var result []replayPartition
	for _, topic := range meta.Topics {
		parts, err := replayTopicPartitions(topic)
		if err != nil {
			return nil, err
		}
		result = append(result, parts...)
	}
	if len(result) == 0 {
		return nil, errors.New("no replay partitions")
	}
	return result, nil
}

func replayTopicPartitions(topic kmsg.MetadataResponseTopic) ([]replayPartition, error) {
	if err := kerr.ErrorForCode(topic.ErrorCode); err != nil {
		return nil, err
	}
	if topic.Topic == nil {
		return nil, errors.New("missing replay topic name")
	}
	var result []replayPartition
	for _, p := range topic.Partitions {
		if err := kerr.ErrorForCode(p.ErrorCode); err != nil {
			return nil, err
		}
		result = append(result, replayPartition{Topic: *topic.Topic, TopicID: topic.TopicID, Partition: p.Partition})
	}
	return result, nil
}

// fillReplayOffsets sets Start (timestamp -2) or End (timestamp -1) for every
// partition and fails unless the broker answered for all of them.
func fillReplayOffsets(ctx context.Context, client *kgo.Client, result []replayPartition, timestamp int64) error {
	response, err := listOffsetsRequest(result, timestamp).RequestWith(ctx, client)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, topic := range response.Topics {
		for _, p := range topic.Partitions {
			if err := kerr.ErrorForCode(p.ErrorCode); err != nil {
				return err
			}
			if setReplayOffset(result, topic.Topic, p.Partition, p.Offset, timestamp) {
				seen[topicPartitionKey(topic.Topic, p.Partition)] = true
			}
		}
	}
	if len(seen) != len(result) {
		return errors.New("incomplete replay offset snapshot")
	}
	return nil
}

func listOffsetsRequest(result []replayPartition, timestamp int64) *kmsg.ListOffsetsRequest {
	offsets := kmsg.NewPtrListOffsetsRequest()
	for _, name := range replayTopics {
		topic := kmsg.ListOffsetsRequestTopic{Topic: name}
		for _, p := range result {
			if p.Topic == name {
				topic.Partitions = append(topic.Partitions, kmsg.ListOffsetsRequestTopicPartition{Partition: p.Partition, Timestamp: timestamp, CurrentLeaderEpoch: -1})
			}
		}
		offsets.Topics = append(offsets.Topics, topic)
	}
	return offsets
}

func setReplayOffset(result []replayPartition, topic string, partition int32, offset, timestamp int64) bool {
	found := false
	for i := range result {
		if result[i].Topic != topic || result[i].Partition != partition {
			continue
		}
		if timestamp == -2 {
			result[i].Start = offset
		} else {
			result[i].End = offset
		}
		found = true
	}
	return found
}

func replayCheckBounds(p replayPartition) error {
	// A shadow with an unknown lost prefix cannot be called a complete rebuild,
	// even when its next checkpoint happens to remain within retention.
	if p.Start != 0 {
		return fmt.Errorf("retained prefix missing: %s/%d starts at %d; rebuild requires preserved canonical IDs from the owning source", p.Topic, p.Partition, p.Start)
	}
	if p.Next < 0 || p.Next > p.End {
		return fmt.Errorf("replay checkpoint outside source frontier: %s/%d", p.Topic, p.Partition)
	}
	return nil
}

func (r *replayRunner) brokerCommit(ctx context.Context, p replayPartition) error {
	req := kmsg.NewPtrOffsetCommitRequest()
	req.Group = r.Group
	req.Generation = -1
	req.Topics = []kmsg.OffsetCommitRequestTopic{{Topic: p.Topic, TopicID: p.TopicID, Partitions: []kmsg.OffsetCommitRequestTopicPartition{{Partition: p.Partition, Offset: p.Next, LeaderEpoch: -1}}}}
	resp, err := req.RequestWith(ctx, r.Client)
	if err != nil {
		return err
	}
	if len(resp.Topics) != 1 || len(resp.Topics[0].Partitions) != 1 {
		return errors.New("incomplete replay commit response")
	}
	return kerr.ErrorForCode(resp.Topics[0].Partitions[0].ErrorCode)
}

func (r *replayRunner) run(ctx context.Context, parts []replayPartition) error {
	assignments, pending, remaining, err := r.plan(ctx, parts)
	if err != nil {
		return err
	}
	r.Client.AddConsumePartitions(assignments)
	for remaining > 0 {
		fetches := r.Client.PollRecords(ctx, 1)
		if err := fetches.Err(); err != nil {
			return err
		}
		for _, record := range fetches.Records() {
			done, err := r.replayRecord(ctx, pending, record)
			if err != nil {
				return err
			}
			if done {
				remaining--
			}
		}
	}
	return nil
}

// plan validates bounds, reconciles broker progress and assigns unfinished partitions.
func (r *replayRunner) plan(ctx context.Context, parts []replayPartition) (map[string]map[int32]kgo.Offset, map[string]map[int32]*replayPartition, int, error) {
	assignments := map[string]map[int32]kgo.Offset{}
	pending := map[string]map[int32]*replayPartition{}
	remaining := 0
	for i := range parts {
		p := &parts[i]
		if err := replayCheckBounds(*p); err != nil {
			return nil, nil, 0, err
		}
		// Reconcile broker progress only after loading durable DB progress. A crash
		// between DB checkpoint and commit is safe and needs no skipped effect.
		if err := r.brokerCommit(ctx, *p); err != nil {
			return nil, nil, 0, err
		}
		if p.Next == p.End {
			continue
		}
		if assignments[p.Topic] == nil {
			assignments[p.Topic] = map[int32]kgo.Offset{}
			pending[p.Topic] = map[int32]*replayPartition{}
		}
		assignments[p.Topic][p.Partition] = kgo.NewOffset().At(p.Next)
		pending[p.Topic][p.Partition] = p
		remaining++
	}
	return assignments, pending, remaining, nil
}

// replayRecord applies one record, saves and commits progress, and reports
// whether its partition reached the snapshot end.
func (r *replayRunner) replayRecord(ctx context.Context, pending map[string]map[int32]*replayPartition, record *kgo.Record) (bool, error) {
	p := pending[record.Topic][record.Partition]
	if p == nil {
		return false, nil
	}
	if record.Offset != p.Next {
		return false, fmt.Errorf("noncontiguous replay source: %s/%d expected %d got %d", p.Topic, p.Partition, p.Next, record.Offset)
	}
	if err := r.apply(ctx, record); err != nil {
		return false, err
	}
	p.Next = record.Offset + 1
	if err := r.Save(ctx, *p); err != nil {
		return false, err
	}
	if err := r.brokerCommit(ctx, *p); err != nil {
		return false, err
	}
	if p.Next != p.End {
		return false, nil
	}
	r.Client.PauseFetchPartitions(map[string][]int32{p.Topic: {p.Partition}})
	delete(pending[p.Topic], p.Partition)
	return true, nil
}

func (r *replayRunner) apply(ctx context.Context, record *kgo.Record) error {
	m := Message{Topic: record.Topic, Partition: record.Partition, Offset: record.Offset, Key: record.Key, Value: record.Value, Headers: record.Headers}
	if string(m.Key) == bindingHeartbeatKey {
		// Replay does not refresh infrastructure freshness from old heartbeats.
		_, err := parseCheckpoint(m, 6)
		return err
	}
	e, reason := r.Validator.validate(m)
	if reason != "" {
		return fmt.Errorf("replay rejected %s/%d/%d: %s", m.Topic, m.Partition, m.Offset, reason)
	}
	if r.Tenant != "all" && e[fieldTenant] != r.Tenant {
		return nil
	}
	err := r.Apply(ctx, m, e)
	if err != nil && !errors.Is(err, ErrDuplicate) {
		return err
	}
	if r.Tenant == "all" {
		return r.RecordTenant(ctx, e[fieldTenant].(string))
	}
	return nil
}

func replayProgress(ctx context.Context, pool *pgxpool.Pool, tenant string, parts []replayPartition, schemas ...string) error {
	return WithTenantSchema(ctx, pool, tenant, replaySchema(schemas), func(ctx context.Context, tx pgx.Tx) error {
		for i := range parts {
			var offset int64
			err := tx.QueryRow(ctx, `SELECT committed_offset FROM projection_checkpoints WHERE tenant_id=$1 AND consumer_name=$2 AND topic=$3 AND partition=$4`, tenant, replayConsumer, parts[i].Topic, parts[i].Partition).Scan(&offset)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			parts[i].Next = offset + 1
		}
		return nil
	})
}
func replaySave(pool *pgxpool.Pool, tenant string, schemas ...string) func(context.Context, replayPartition) error {
	return func(ctx context.Context, p replayPartition) error {
		return WithTenantSchema(ctx, pool, tenant, replaySchema(schemas), func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO projection_checkpoints(tenant_id,consumer_name,topic,partition,committed_offset) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,consumer_name,topic,partition) DO UPDATE SET committed_offset=EXCLUDED.committed_offset,last_projected_at=clock_timestamp() WHERE projection_checkpoints.committed_offset<EXCLUDED.committed_offset`, tenant, replayConsumer, p.Topic, p.Partition, p.Next-1)
			return err
		})
	}
}

func replaySchema(schemas []string) string {
	if len(schemas) == 0 {
		return "public"
	}
	return schemas[0]
}

// Only the reserved infrastructure tenant can enumerate replayed tenant IDs.
// Projection rows remain subject to their own tenant RLS and application filter.
func replayRecordTenant(pool *pgxpool.Pool, schema string) func(context.Context, string) error {
	return func(ctx context.Context, eventTenant string) error {
		if !tenantPattern.MatchString(eventTenant) || eventTenant == infrastructureTenant {
			return ErrInvalidTenant
		}
		return WithTenantSchema(ctx, pool, infrastructureTenant, schema, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO projection_replay_tenants(tenant_id,event_tenant) VALUES($1,$2) ON CONFLICT DO NOTHING`, infrastructureTenant, eventTenant)
			return err
		})
	}
}

func compareAllShadow(ctx context.Context, pool *pgxpool.Pool, out io.Writer, schema string) error {
	tenants, err := replayedTenants(ctx, pool, schema)
	if err != nil {
		return err
	}
	if len(tenants) == 0 {
		return errors.New("global replay has no recorded tenants")
	}
	for _, tenant := range tenants {
		if err := compareShadow(ctx, pool, tenant, out, schema); err != nil {
			return fmt.Errorf("compare tenant %s: %w", tenant, err)
		}
	}
	return nil
}

// replayJob carries the validated request and opened resources for one run.
type replayJob struct {
	getenv           func(string) string
	out              io.Writer
	action, tenant   string
	global           bool
	checkpointTenant string
	schema, database string
	pool             *pgxpool.Pool
	client           *kgo.Client
	parts            []replayPartition
}

const (
	replayAllTenants = "all"
	publicSchema     = "public"
	projectionRole   = "projection_app"
)

func runReplay(ctx context.Context, getenv func(string) string, out io.Writer) error {
	job, err := parseReplayRequest(getenv, out)
	if err != nil {
		return err
	}
	cfg, err := job.replayConfig()
	if err != nil {
		return err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return errors.New("open replay database failed")
	}
	defer pool.Close()
	job.pool = pool
	if err := job.checkDatabase(ctx, cfg.ConnConfig.Database); err != nil {
		return err
	}
	client, err := newReplayClient(getenv)
	if err != nil {
		return err
	}
	defer client.Close()
	job.client = client
	if err := job.loadParts(ctx); err != nil {
		return err
	}
	return job.dispatch(ctx)
}

func parseReplayRequest(getenv func(string) string, out io.Writer) (*replayJob, error) {
	action := getenv("PROJECTION_REPLAY_ACTION")
	if action != "rebuild" && action != "status" && action != "compare" && action != "verify" {
		return nil, errors.New("PROJECTION_REPLAY_ACTION must be rebuild, status, compare, or verify")
	}
	tenant := getenv("PROJECTION_REPLAY_TENANT")
	if tenant != replayAllTenants && (!tenantPattern.MatchString(tenant) || tenant == infrastructureTenant) {
		return nil, ErrInvalidTenant
	}
	job := &replayJob{getenv: getenv, out: out, action: action, tenant: tenant, global: tenant == replayAllTenants, checkpointTenant: tenant}
	if job.global {
		job.checkpointTenant = infrastructureTenant
	}
	return job, nil
}

// replayConfig selects the target database and enforces the shadow/role rules.
func (j *replayJob) replayConfig() (*pgxpool.Config, error) {
	j.schema = j.getenv("PROJECTION_REPLAY_SCHEMA")
	url := j.getenv("PROJECTION_REPLAY_DATABASE_URL")
	if j.schema != "" {
		url = j.getenv("PROJECTION_DATABASE_URL")
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, errors.New("invalid replay database configuration")
	}
	if j.schema == "" {
		j.schema = publicSchema
		if !replayDatabasePattern.MatchString(cfg.ConnConfig.Database) {
			return nil, errors.New("replay target must be a separately provisioned greenguard_read_replay_<name> database")
		}
	} else if !versionSchemaPattern.MatchString(j.schema) || cfg.ConnConfig.Database != "greenguard_read" {
		return nil, errors.New("versioned replay requires read_v<N> in greenguard_read")
	}
	if cfg.ConnConfig.User != projectionRole {
		return nil, errors.New("replay requires the restricted projection_app role")
	}
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	return cfg, nil
}

func (j *replayJob) checkDatabase(ctx context.Context, expected string) error {
	var role string
	var bypass bool
	if err := j.pool.QueryRow(ctx, `SELECT current_database(),current_user,rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user`).Scan(&j.database, &role, &bypass); err != nil {
		return err
	}
	if j.database != expected || role != projectionRole || bypass {
		return errors.New("unsafe replay database or role")
	}
	if j.schema == publicSchema {
		return nil
	}
	var total, forced int
	if err := j.pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE relnamespace=$1::regnamespace AND relkind IN ('r','p') AND NOT relispartition`, j.schema).Scan(&total, &forced); err != nil || total != 19 || forced != total {
		return errors.New("versioned replay schema missing or RLS incomplete")
	}
	return nil
}

func newReplayClient(getenv func(string) string) (*kgo.Client, error) {
	brokers := getenv("KAFKA_BROKERS")
	if strings.TrimSpace(brokers) == "" {
		return nil, errors.New("KAFKA_BROKERS is required")
	}
	security, err := transport.SecurityOptions(getenv)
	if err != nil {
		return nil, err
	}
	options := append([]kgo.Opt{kgo.SeedBrokers(strings.Split(brokers, ",")...), kgo.ConsumeResetOffset(kgo.NoResetOffset())}, security...)
	return kgo.NewClient(options...)
}

func (j *replayJob) loadParts(ctx context.Context) error {
	parts, err := replayBounds(ctx, j.client)
	if err != nil {
		return err
	}
	if err := replayProgress(ctx, j.pool, j.checkpointTenant, parts, j.schema); err != nil {
		return err
	}
	for _, p := range parts {
		if err := replayCheckBounds(p); err != nil {
			return err
		}
	}
	j.parts = parts
	return nil
}

func (j *replayJob) dispatch(ctx context.Context) error {
	switch {
	case j.action == "verify":
		return j.verify(ctx)
	case j.action == "compare":
		return j.compare(ctx)
	case j.action == "status" || j.getenv("PROJECTION_REPLAY_DRY_RUN") == "1":
		return json.NewEncoder(j.out).Encode(j.parts)
	default:
		return j.rebuild(ctx)
	}
}

func eventSchemaDir(getenv func(string) string) string {
	if dir := getenv("EVENT_SCHEMA_DIR"); dir != "" {
		return dir
	}
	return "../../contracts/events"
}

func (j *replayJob) verify(ctx context.Context) error {
	if !j.global || j.schema == publicSchema {
		return errors.New("canonical verification requires all tenants and a versioned shadow")
	}
	schemas, err := loadSchemas(eventSchemaDir(j.getenv))
	if err != nil {
		return err
	}
	if err := verifyCanonicalComparison(ctx, j.client, &Processor{Schemas: schemas}, j.pool, j.parts, j.schema); err != nil {
		return err
	}
	return json.NewEncoder(j.out).Encode(map[string]any{"verified": true, "shadow": j.schema, "partitions": j.parts})
}

func (j *replayJob) compare(ctx context.Context) error {
	for _, p := range j.parts {
		if p.Next != p.End {
			return fmt.Errorf("shadow replay has source lag: %s/%d next %d end %d", p.Topic, p.Partition, p.Next, p.End)
		}
	}
	if j.global {
		return compareAllShadow(ctx, j.pool, j.out, j.schema)
	}
	return compareShadow(ctx, j.pool, j.tenant, j.out, j.schema)
}

func (j *replayJob) rebuild(ctx context.Context) error {
	// A transaction-level lock serializes runners for this shadow, including
	// transaction-pooled connections. A separate pool connection performs effects.
	lock, err := j.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer lock.Rollback(context.Background())
	if err := j.lockShadow(ctx, lock); err != nil {
		return err
	}
	// Reload progress under the writer lock: a prior runner may just have finished.
	if err := replayProgress(ctx, j.pool, j.checkpointTenant, j.parts, j.schema); err != nil {
		return err
	}
	schemas, err := loadSchemas(eventSchemaDir(j.getenv))
	if err != nil {
		return err
	}
	window, err := history.Window(j.getenv)
	if err != nil {
		return err
	}
	runner := j.newRunner(schemas, window)
	if err := replayManifest(ctx, j.pool, j.checkpointTenant, j.parts, window, j.schema); err != nil {
		return err
	}
	if err := runner.run(ctx, j.parts); err != nil {
		return err
	}
	return json.NewEncoder(j.out).Encode(j.parts)
}

// lockShadow takes the replay advisory lock and refuses an active versioned writer.
func (j *replayJob) lockShadow(ctx context.Context, lock pgx.Tx) error {
	lockKey, err := replayLockKey(j.schema)
	if err != nil {
		return err
	}
	var acquired bool
	if err := lock.QueryRow(ctx, "SELECT pg_try_advisory_xact_lock(7240512,$1::integer)", lockKey).Scan(&acquired); err != nil {
		return err
	}
	if !acquired {
		return errors.New("another replay owns this shadow database")
	}
	if j.schema == publicSchema {
		return nil
	}
	if _, err := lock.Exec(ctx, "SELECT set_config('app.tenant_id',$1,true)", infrastructureTenant); err != nil {
		return err
	}
	var active bool
	if err := lock.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM public.projection_writer_leases WHERE tenant_id=$1 AND schema_name=$2 AND expires_at>clock_timestamp())`, infrastructureTenant, j.schema).Scan(&active); err != nil {
		return err
	}
	if active {
		return errors.New("versioned writer lease active; stop writer before replay")
	}
	return nil
}

func (j *replayJob) newRunner(schemas schemas, window time.Duration) *replayRunner {
	store := &Store{DB: j.pool, Schema: j.schema, HistoryWindow: window}
	group := j.database + "-" + j.tenant
	if j.schema != publicSchema {
		group = "greenguard.projection-builder." + j.schema
		if !j.global {
			group += "." + j.tenant
		}
	}
	runner := &replayRunner{Client: j.client, Store: store, Tenant: j.tenant, Group: group, Validator: &Processor{Schemas: schemas}, Apply: store.Apply, Save: replaySave(j.pool, j.checkpointTenant, j.schema)}
	if j.global {
		runner.RecordTenant = replayRecordTenant(j.pool, j.schema)
	}
	return runner
}

func replayMain(ctx context.Context, getenv func(string) string) error {
	if err := common.RequireShardRegistry(getenv); err != nil {
		return err
	}
	if getenv("SHARD_REGISTRY_FILE") != "" {
		return errors.New("sharded operational replay requires an explicit shard migration/replay protocol; fixed replay URLs are not admitted")
	}
	// Finite operational command; no HTTP server or live consumer is started.
	bounded, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	return runReplay(bounded, getenv, os.Stdout)
}

func replayManifest(ctx context.Context, pool *pgxpool.Pool, tenant string, parts []replayPartition, window time.Duration, schemas ...string) error {
	return WithTenantSchema(ctx, pool, tenant, replaySchema(schemas), func(ctx context.Context, tx pgx.Tx) error {
		for _, p := range parts {
			if p.TopicID == [16]byte{} {
				return errors.New("broker did not provide stable replay topic identity")
			}
			id := fmt.Sprintf("%x-%x-%x-%x-%x", p.TopicID[:4], p.TopicID[4:6], p.TopicID[6:8], p.TopicID[8:10], p.TopicID[10:])
			if _, err := tx.Exec(ctx, `INSERT INTO projection_replay_manifest(tenant_id,topic,topic_id,hot_window_seconds) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, tenant, p.Topic, id, int64(window.Seconds())); err != nil {
				return err
			}
			var matches bool
			if err := tx.QueryRow(ctx, `SELECT topic_id=$3::uuid AND hot_window_seconds=$4 FROM projection_replay_manifest WHERE tenant_id=$1 AND topic=$2`, tenant, p.Topic, id, int64(window.Seconds())).Scan(&matches); err != nil {
				return err
			}
			if !matches {
				return errors.New("replay source incarnation or history window changed; provision a new shadow")
			}
		}
		return nil
	})
}
