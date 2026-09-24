package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"greenguard.local/projection-builder/history"
)

const migrationURL = "PROJECTION_MIGRATION_URL"
const testURL = "postgres://nobody@127.0.0.1:1/none"

func values(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
func TestRun(t *testing.T) {
	old := maintain
	t.Cleanup(func() { maintain = old })
	failure := errors.New("maintenance failed")
	maintain = func(ctx context.Context, _ history.Starter, w time.Duration, a int, schemas ...string) error {
		if _, ok := ctx.Deadline(); !ok || w != history.DefaultWindow || a != 3 {
			t.Fatal("configuration/deadline")
		}
		if len(schemas) != 1 || schemas[0] != "public" {
			t.Fatal("schema", schemas)
		}
		return failure
	}
	for _, env := range []map[string]string{
		{}, {history.WindowEnv: "bad"}, {history.AheadEnv: "bad"}, {migrationURL: "not a url"},
	} {
		if err := run(context.Background(), values(env)); err == nil {
			t.Fatal(env)
		}
	}
	if err := run(context.Background(), values(map[string]string{migrationURL: testURL})); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	maintain = func(context.Context, history.Starter, time.Duration, int, ...string) error { return nil }
	if err := run(context.Background(), values(map[string]string{migrationURL: testURL})); err != nil {
		t.Fatal(err)
	}
}
func TestMain(t *testing.T) {
	oldExit, oldMaintain := exit, maintain
	t.Cleanup(func() { exit = oldExit; maintain = oldMaintain })
	t.Setenv(history.WindowEnv, "")
	t.Setenv(history.AheadEnv, "")
	t.Setenv(migrationURL, "")
	called := 0
	exit = func(code int) {
		called++
		if code != 1 {
			t.Fatal(code)
		}
	}
	main()
	if called != 1 {
		t.Fatal(called)
	}
	t.Setenv(migrationURL, testURL)
	maintain = func(context.Context, history.Starter, time.Duration, int, ...string) error { return nil }
	main()
	if called != 1 {
		t.Fatal(called)
	}
}
