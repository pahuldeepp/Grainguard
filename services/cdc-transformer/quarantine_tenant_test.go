package main

import (
	"encoding/json"
	"testing"
)

func TestQuarantineTenantHeader(t *testing.T) {
	const tenant = "3f2b8c1e-9a4d-4e7b-8c55-1d2e3f4a5b6c"
	for _, tc := range []struct{ raw, want string }{
		{`{"after":{"tenant_id":"` + tenant + `"}}`, tenant},
		{`{"payload":{"after":{"tenant_id":"` + tenant + `"}}}`, tenant},
		{`{"after":{"tenant_id":"BAD"}}`, unknownTenant},
		{`{"after":{"tenant_id":42}}`, unknownTenant},
		{`{"after":{}}`, unknownTenant},
		{`{"tenant_id":"` + tenant + `","source":{"tenant_id":"` + tenant + `"}}`, unknownTenant},
		{`{"payload":null}`, unknownTenant},
		{`[]`, unknownTenant},
		{`{`, unknownTenant},
		{`{"after":{"tenant_id":"3F2B8C1E-9A4D-4E7B-8C55-1D2E3F4A5B6C"}}`, unknownTenant},
	} {
		r := quarantineRecord(Message{Topic: rawInventory, Value: []byte(tc.raw)}, fail(reasonSchema, "invalid"))
		if r.Headers[fieldTenant] != tc.want || string(r.Key) != rawInventory+":0:0" {
			t.Fatal(r.Headers, string(r.Key))
		}
		var q quarantine
		if err := json.Unmarshal(r.Value, &q); err != nil || string(q.Raw) != tc.raw {
			t.Fatal(q, err)
		}
	}
}
