package common

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// InfrastructureDB is explicitly bound to one private shard. Raw transactions
// are reserved infrastructure transactions; customer helpers still resolve the
// current authority route, including work discovered on a previous shard.
type InfrastructureDB struct {
	router *ShardedDB
	shard  string
}

func (s *ShardedDB) InfrastructureDB(shard string) *InfrastructureDB {
	return &InfrastructureDB{router: s, shard: shard}
}
func (b *InfrastructureDB) BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error) {
	pool, err := b.router.Primary(ctx, b.shard)
	if err != nil {
		return nil, err
	}
	tx, err := pool.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, InfrastructureTenant); err != nil {
		_ = Rollback(tx)
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT greenguard_internal.admit_shard_infrastructure($1::text,$2::uuid)`, b.shard, b.router.registry.Shards[b.shard].Incarnation); err != nil {
		_ = Rollback(tx)
		return nil, errors.Join(ErrTenantAdmissionRejected, err)
	}
	return tx, nil
}
func (b *InfrastructureDB) WithTenantSchema(ctx context.Context, tenant, schema string, fn func(context.Context, pgx.Tx) error) error {
	if tenant == InfrastructureTenant {
		return b.router.WithInfrastructure(ctx, b.shard, schema, fn)
	}
	return b.router.WithTenantSchema(ctx, tenant, schema, fn)
}

// WithInfrastructure targets transport/worker ledgers explicitly by shard.
// The registry pins the shard incarnation; durable bootstrap supplies its epoch.
// Reserved infrastructure is not a customer with a global control-plane route.
func (s *ShardedDB) WithInfrastructure(ctx context.Context, shard, schema string, fn func(context.Context, pgx.Tx) error) error {
	if schema != "" && schema != "public" && !projectionSchema.MatchString(schema) {
		return ErrInvalidTenantPlacement
	}
	pool, err := s.Primary(ctx, shard)
	if err != nil {
		return err
	}
	endpoint := s.registry.Shards[shard]
	return WithTenantSchema(ctx, pool, InfrastructureTenant, schema, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT greenguard_internal.admit_shard_infrastructure($1::text,$2::uuid)`, shard, endpoint.Incarnation); err != nil {
			return errors.Join(ErrTenantAdmissionRejected, err)
		}
		return fn(ctx, tx)
	})
}

// ShardInfrastructureAdmissionSQL is installed by each owner migration. It
// reveals no tenant ownership rows and accepts only the reserved transaction
// context and configured shard/incarnation. Runtime cannot seed/change it.
const ShardInfrastructureAdmissionSQL = `
CREATE FUNCTION greenguard_internal.admit_shard_infrastructure(p_shard text,p_incarnation uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE o greenguard_internal.tenant_ownership%ROWTYPE;
BEGIN
 IF NULLIF(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM '00000000-0000-4000-8000-000000000001'::uuid THEN
  RAISE EXCEPTION 'reserved infrastructure context required' USING ERRCODE='insufficient_privilege';
 END IF;
 IF current_setting('transaction_read_only')='on' THEN
  SELECT * INTO o FROM greenguard_internal.tenant_ownership WHERE tenant_id='00000000-0000-4000-8000-000000000001'::uuid;
 ELSE
  SELECT * INTO o FROM greenguard_internal.tenant_ownership WHERE tenant_id='00000000-0000-4000-8000-000000000001'::uuid FOR SHARE;
 END IF;
 IF NOT FOUND OR o.state<>'active' OR o.shard_id IS DISTINCT FROM p_shard OR o.shard_incarnation IS DISTINCT FROM p_incarnation THEN
  RAISE EXCEPTION 'infrastructure bootstrap missing or mismatched' USING ERRCODE='insufficient_privilege';
 END IF;
 PERFORM set_config('app.shard_id',o.shard_id,true);
 PERFORM set_config('app.shard_incarnation',o.shard_incarnation::text,true);
 PERFORM set_config('app.placement_epoch',o.placement_epoch::text,true);
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.admit_shard_infrastructure(text,uuid) FROM PUBLIC;
`
