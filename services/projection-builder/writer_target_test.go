package main

import "testing"

func TestVersionedWriterTargetRequiresRestrictedLiveDatabase(t *testing.T) {
	schema, group, err := writerTarget("read_v2", "greenguard_read", "projection_app")
	if err != nil || schema != "read_v2" || group != "greenguard.projection-builder.read_v2" {
		t.Fatalf("target=%q group=%q err=%v", schema, group, err)
	}
	for _, tc := range []struct{ schema, database, role string }{
		{"read_v2;DROP", "greenguard_read", "projection_app"},
		{"read_v2", "greenguard_read_replay_test", "projection_app"},
		{"read_v2", "greenguard_read", "postgres"},
	} {
		if _, _, err := writerTarget(tc.schema, tc.database, tc.role); err == nil {
			t.Fatalf("unsafe target accepted: %+v", tc)
		}
	}
}
