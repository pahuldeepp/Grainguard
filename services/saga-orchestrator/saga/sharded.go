package saga

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
	"net/http"
	"time"
)

// PlacementLeases selects the physical owner database's independent 64
// scheduling leases after customer placement has admitted the transaction.
type PlacementLeases map[string]*Leases

func (leases PlacementLeases) Check(ctx context.Context, tx pgx.Tx, tenant string) error {
	var shard string
	if err := tx.QueryRow(ctx, "SELECT current_setting('app.shard_id')").Scan(&shard); err != nil {
		return err
	}
	lease := leases[shard]
	if lease == nil {
		return ErrLeaseLost
	}
	return lease.Check(ctx, tx, tenant)
}

// ShardedHandler reads only existing count-only selectors on each explicit
// primary. An unavailable shard makes the whole scrape unavailable.
func ShardedHandler(m *Metrics, db *common.ShardedDB) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		all := Gauges{States: map[string]int64{}}
		err := db.ForEachPrimary(ctx, func(shard string, _ *pgxpool.Pool) error {
			tx, err := db.InfrastructureDB(shard).BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
			if err != nil {
				return err
			}
			defer common.Rollback(tx)
			g, err := ReadGauges(ctx, tx)
			if err != nil {
				return err
			}
			for state, n := range g.States {
				all.States[state] += n
			}
			all.Overdue += g.Overdue
			all.PendingCommands += g.PendingCommands
			all.OldestPending = max(all.OldestPending, g.OldestPending)
			return tx.Commit(ctx)
		})
		if err != nil {
			http.Error(w, "saga metrics unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		m.Write(w, all)
	})
}
