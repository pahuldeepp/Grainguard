// Package migrations owns the forward-only saga database schema.
package migrations

import (
	"embed"

	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	shared "greenguard.local/go-migrations"
)

//go:embed *.sql
var files embed.FS

// Up applies pending migrations through the direct, table-owning connection.
func Up(databaseURL string) error {
	return shared.Up(databaseURL, func() (source.Driver, error) { return iofs.New(files, ".") }, shared.Connect)
}
