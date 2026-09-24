package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type promotionDB struct {
	tx     *promotionTx
	begins int
}

func (d *promotionDB) BeginTx(_ context.Context, options pgx.TxOptions) (pgx.Tx, error) {
	d.begins++
	if options.IsoLevel != pgx.RepeatableRead {
		return nil, errors.New("promotion needs a stable database snapshot")
	}
	return d.tx, nil
}

type promotionTx struct {
	pgx.Tx
	queries            []string
	failAt             int
	commits, rollbacks int
}

func (t *promotionTx) QueryRow(_ context.Context, _ string, args ...any) pgx.Row {
	if len(args) == 0 {
		return routeRow{definition: "SELECT * FROM read.device_latest JOIN public.consumer_inbox AS i ON true LEFT JOIN read.reading_history AS h ON true"}
	}
	name := strings.TrimPrefix(args[0].(string), "read.")
	return routeRow{definition: "SELECT * FROM public." + name + ";"}
}

func (t *promotionTx) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	t.queries = append(t.queries, sql)
	if t.failAt == len(t.queries) {
		return pgconn.CommandTag{}, errors.New("injected DDL failure")
	}
	return pgconn.CommandTag{}, nil
}
func (t *promotionTx) Commit(context.Context) error   { t.commits++; return nil }
func (t *promotionTx) Rollback(context.Context) error { t.rollbacks++; return nil }
func fullPromotionProof() PromotionProof              { return PromotionProof{true, true, true, true, true, true} }

func TestPromotionFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name     string
		proof    PromotionProof
		verifier bool
	}{
		{"missing verifier", PromotionProof{}, false},
		{"missing all-tenant replay", PromotionProof{false, true, true, true, true, true}, true},
		{"unstable frontier", PromotionProof{true, false, true, true, true, true}, true},
		{"live mismatch", PromotionProof{true, true, false, true, true, true}, true},
		{"canonical reference missing", PromotionProof{true, true, true, false, true, true}, true},
		{"lagging", PromotionProof{true, true, true, true, false, true}, true},
		{"post-swap consumer unavailable", PromotionProof{true, true, true, true, true, false}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := &promotionDB{tx: &promotionTx{}}
			var verify PromotionVerifier
			if tc.verifier {
				verify = func(context.Context, pgx.Tx, string) (PromotionProof, error) { return tc.proof, nil }
			}
			if err := PromoteReadViews(context.Background(), db, "read_v2", verify); err == nil {
				t.Fatal("promotion accepted incomplete proof")
			}
			if db.tx.commits != 0 || len(db.tx.queries) > 2 {
				t.Fatalf("view replacement started: %+v", db.tx)
			}
		})
	}
}

func TestPromotionRollbackOnFailure(t *testing.T) {
	db := &promotionDB{tx: &promotionTx{failAt: 3}}
	verify := func(context.Context, pgx.Tx, string) (PromotionProof, error) { return fullPromotionProof(), nil }
	if err := PromoteReadViews(context.Background(), db, "read_v2", verify); err == nil {
		t.Fatal("expected DDL failure")
	}
	if db.tx.commits != 0 || db.tx.rollbacks != 1 {
		t.Fatalf("transaction not rolled back: %+v", db.tx)
	}
}

func TestPromotionSecureViewsAndIdempotence(t *testing.T) {
	verify := func(context.Context, pgx.Tx, string) (PromotionProof, error) { return fullPromotionProof(), nil }
	for i := 0; i < 2; i++ {
		db := &promotionDB{tx: &promotionTx{}}
		if err := PromoteReadViews(context.Background(), db, "read_v2", verify); err != nil {
			t.Fatal(err)
		}
		if db.tx.commits != 1 || len(db.tx.queries) != 10 {
			t.Fatalf("unexpected transaction: %+v", db.tx)
		}
		for _, q := range db.tx.queries[2:6] {
			if !strings.Contains(q, "security_invoker=true, security_barrier=true") || !strings.Contains(q, "SELECT * FROM read_v2.") {
				t.Fatalf("insecure view: %s", q)
			}
		}
		if q := db.tx.queries[9]; !strings.Contains(q, "JOIN read_v2.consumer_inbox") || !strings.Contains(q, "security_invoker=true, security_barrier=true") {
			t.Fatalf("latest view not routed to promoted inbox: %s", q)
		}
	}
}

func TestPromotionRejectsInvalidSchemaBeforeTransaction(t *testing.T) {
	db := &promotionDB{tx: &promotionTx{}}
	if err := PromoteReadViews(context.Background(), db, "read_v2; DROP SCHEMA read", func(context.Context, pgx.Tx, string) (PromotionProof, error) { return fullPromotionProof(), nil }); err == nil || db.begins != 0 {
		t.Fatal("invalid schema accepted")
	}
}
