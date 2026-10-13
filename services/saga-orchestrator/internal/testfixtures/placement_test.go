package testfixtures

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestPlacementTracerIgnoresUnscopedOrInvalidTenantQueries(t *testing.T) {
	tracer := fixturePlacementTracer{t: t}
	ctx := context.Background()
	for _, query := range []pgx.TraceQueryStartData{
		{SQL: "SELECT 1"},
		{SQL: "SELECT set_config('app.tenant_id', $1, true)"},
		{SQL: "SELECT set_config('app.tenant_id', $1, true)", Args: []any{"bad-tenant"}},
		{SQL: "SELECT set_config('app.tenant_id', $1, true)", Args: []any{7}},
		{SQL: "SELECT set_config('app.tenant_id', $1, true)", Args: []any{"tenant", "extra"}},
	} {
		if actual := tracer.TraceQueryStart(ctx, nil, query); actual != ctx {
			t.Fatal("fixture tracer changed the context for a query it must ignore")
		}
	}
}
