package migrations

import (
	"errors"
	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/source"
	"testing"
)

type fakeRunner struct {
	err    error
	closed bool
}

func (f *fakeRunner) Up() error             { return f.err }
func (f *fakeRunner) Close() (error, error) { f.closed = true; return nil, nil }
func TestMigrationLifecycle(t *testing.T) {
	old := connect
	defer func() { connect = old }()
	for _, e := range []error{nil, migrate.ErrNoChange, errors.New("sql failure")} {
		r := &fakeRunner{err: e}
		connect = func(s source.Driver, url string) (runner, error) {
			defer s.Close()
			if url != "pgx5://test" {
				t.Fatal(url)
			}
			if v, err := s.First(); v != 1 || err != nil {
				t.Fatal(v, err)
			}
			return r, nil
		}
		err := Up("postgres://test")
		if (err != nil) != (e != nil && e != migrate.ErrNoChange) || !r.closed {
			t.Fatal(err, r.closed)
		}
	}
	connect = func(source.Driver, string) (runner, error) { return nil, errors.New("secret") }
	if err := Up("postgresql://test"); err == nil || err.Error() != "connect for migration failed" {
		t.Fatal(err)
	}
}
func TestMigrationSourceFailure(t *testing.T) {
	old := newSource
	defer func() { newSource = old }()
	newSource = func() (source.Driver, error) { return nil, errors.New("source missing") }
	if Up("x") == nil {
		t.Fatal("missing failure")
	}
	if driverURL("other://test") != "other://test" {
		t.Fatal("unexpected rewrite")
	}
}
