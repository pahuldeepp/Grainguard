// Package migrations provides the shared direct-Postgres migration lifecycle.
package migrations

import (
	"errors"
	"fmt"
	"log/slog"
	neturl "net/url"
	"os"
	"strings"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	"github.com/golang-migrate/migrate/v4/source"
)

type Runner interface {
	Up() error
	Close() (error, error)
}

func Connect(src source.Driver, url string) (Runner, error) {
	return migrate.NewWithSourceInstance("iofs", src, url)
}

func DriverURL(databaseURL string) string {
	for _, scheme := range []string{"postgresql://", "postgres://"} {
		if rest, ok := strings.CutPrefix(databaseURL, scheme); ok {
			return "pgx5://" + rest
		}
	}
	return databaseURL
}

// Up takes a direct connection; its session advisory lock is incompatible with
// PgBouncer transaction pooling. Source and Connect remain injectable for tests.
func Up(databaseURL string, newSource func() (source.Driver, error), connect func(source.Driver, string) (Runner, error)) (result error) {
	src, err := newSource()
	if err != nil {
		return fmt.Errorf("open migrations: %w", err)
	}
	m, err := connect(src, DriverURL(databaseURL))
	if err != nil {
		_ = src.Close()
		return errors.New("connect for migration failed")
	}
	defer func() {
		sourceErr, databaseErr := m.Close()
		result = errors.Join(result, wrapClose("source", sourceErr), wrapClose("database", databaseErr))
	}()
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}

func wrapClose(component string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("close migration %s: %w", component, err)
}

type UsageError string

func (e UsageError) Error() string { return string(e) }

func Run(envKey string, getenv func(string) string, up func(string) error) error {
	url := getenv(envKey)
	if url == "" {
		return UsageError(envKey + " is required")
	}
	if getenv("GG_RDS") == "1" {
		parsed, err := neturl.Parse(url)
		if err != nil {
			return UsageError(envKey + " must use a PostgreSQL URL with sslmode=verify-full and sslrootcert=/rds-ca/ca.pem for RDS")
		}
		query := parsed.Query()
		if (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Hostname() == "" ||
			len(query["sslmode"]) != 1 || query.Get("sslmode") != "verify-full" ||
			len(query["sslrootcert"]) != 1 || query.Get("sslrootcert") != "/rds-ca/ca.pem" ||
			query.Has("host") || query.Has("hostaddr") {
			return UsageError(envKey + " must use a PostgreSQL URL with sslmode=verify-full and sslrootcert=/rds-ca/ca.pem for RDS")
		}
	}
	return up(url)
}

func Main(envKey string, up func(string) error, exit func(int)) {
	if err := Run(envKey, os.Getenv, up); err != nil {
		slog.Error("migration failed", "error", err)
		exit(1)
	}
}
