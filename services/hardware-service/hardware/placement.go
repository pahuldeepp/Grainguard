package hardware

import (
	"context"
	"github.com/jackc/pgx/v5"
	common "greenguard.local/go-common"
)

// WithExternalAdmission keeps the durable ownership fence locked until the
// external acknowledgement, using the current customer placement. The stable
// command/result ID remains the external idempotency key if commit is uncertain.
func (s Store) WithExternalAdmission(ctx context.Context, tenant string, effect func() error) error {
	if _, ok := s.DB.(common.TenantTransactionRouter); !ok {
		return effect()
	}
	return common.WithTenantSchema(ctx, s.DB, tenant, "", func(_ context.Context, _ pgx.Tx) error { return effect() })
}
