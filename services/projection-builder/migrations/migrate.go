// Package migrations applies the projection-builder database schema.
package migrations

import (
	"embed"

	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	shared "greenguard.local/go-migrations"
)

//go:embed *.sql
var files embed.FS

type runner = shared.Runner

var connect = shared.Connect
var newSource = func() (source.Driver, error) { return iofs.New(files, ".") }

func driverURL(databaseURL string) string { return shared.DriverURL(databaseURL) }

// Up applies every pending migration using the table-owning migrator role.
func Up(databaseURL string) error { return shared.Up(databaseURL, newSource, connect) }
