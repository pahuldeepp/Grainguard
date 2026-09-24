package migrations

import (
	"errors"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/iofs"
)

type fakeRunner struct {
	upErr            error
	sourceCloseErr   error
	databaseCloseErr error
	closed           bool
}

func (r *fakeRunner) Up() error { return r.upErr }
func (r *fakeRunner) Close() (error, error) {
	r.closed = true
	return r.sourceCloseErr, r.databaseCloseErr
}

func testSource() (source.Driver, error) {
	return iofs.New(fstest.MapFS{"000001_initial.up.sql": &fstest.MapFile{Data: []byte("SELECT 1;")}}, ".")
}

func TestUpReportsCloseFailures(t *testing.T) {
	sourceFailure := errors.New("source close failed")
	databaseFailure := errors.New("database close failed")
	applyFailure := errors.New("apply failed")
	for _, tc := range []struct {
		name   string
		runner fakeRunner
		want   []error
	}{
		{"source", fakeRunner{sourceCloseErr: sourceFailure}, []error{sourceFailure}},
		{"database", fakeRunner{databaseCloseErr: databaseFailure}, []error{databaseFailure}},
		{"both after apply", fakeRunner{upErr: applyFailure, sourceCloseErr: sourceFailure, databaseCloseErr: databaseFailure}, []error{applyFailure, sourceFailure, databaseFailure}},
		{"no change with close failure", fakeRunner{upErr: migrate.ErrNoChange, databaseCloseErr: databaseFailure}, []error{databaseFailure}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := tc.runner
			err := Up("postgres://user:secret@example.test/db", testSource, func(src source.Driver, url string) (Runner, error) {
				if url != "pgx5://user:secret@example.test/db" {
					t.Fatalf("driver URL %q", url)
				}
				return &r, nil
			})
			if !r.closed {
				t.Fatal("migration runner was not closed")
			}
			for _, want := range tc.want {
				if !errors.Is(err, want) {
					t.Fatalf("error %v does not contain %v", err, want)
				}
			}
		})
	}
}

func TestConnectFailureRedactsCredentials(t *testing.T) {
	err := Up("postgres://user:secret@example.test/db", testSource, func(source.Driver, string) (Runner, error) { return nil, errors.New("user:secret") })
	if err == nil || err.Error() != "connect for migration failed" || strings.Contains(err.Error(), "secret") {
		t.Fatalf("error %v", err)
	}
}
