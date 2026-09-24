// Package migrations applies the telemetry database schema.
package migrations

import (
	"embed"
	"errors"
	"fmt"
	"strings"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/iofs"
)

//go:embed *.sql
var files embed.FS

var newSource = func() (source.Driver, error) { return iofs.New(files, ".") }

// driverURL selects the pgx v5 driver for either PostgreSQL URL scheme and leaves any
// other scheme unchanged, so a mistake fails at connect time instead of being rewritten.
func driverURL(databaseURL string) string {
	for _, scheme := range []string{"postgresql://", "postgres://"} {
		if rest, ok := strings.CutPrefix(databaseURL, scheme); ok {
			return "pgx5://" + rest
		}
	}
	return databaseURL
}

// Up applies every pending migration. It needs a direct connection as the table-owning
// migrator role, because it takes a session-level advisory lock that PgBouncer transaction
// pooling cannot hold.
func Up(databaseURL string) error {
	src, err := newSource()
	if err != nil {
		return fmt.Errorf("open migrations: %w", err)
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, driverURL(databaseURL))
	if err != nil {
		return errors.New("connect for migration failed")
	}
	defer m.Close()
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}
