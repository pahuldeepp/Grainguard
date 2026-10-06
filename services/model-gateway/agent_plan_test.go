package modelgateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAgentPlanBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, output, tenant string
		want                 int
	}{
		{"knowledge explanatory unused fields", `{"tool":"search_knowledge","query":"grain moisture","alert_id":"foreign","device_id":"foreign","note":"Relevant document search","etag":"irrelevant"}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 200},
		{"native envelope", `{"plan":{"tool":"query_device_facts","args":{"device_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","operation":"telemetry_latest"}}}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 200},
		{"native envelope unknown authority", `{"plan":{"tool":"abstain","args":{}},"tenant_id":"foreign"}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 502},
		{"nested structured catalog", `{"tool":"query_structured_knowledge","args":{"query":"How many ready PDFs do I have?"}}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 200},
		{"nested latest", `{"tool":"query_device_facts","args":{"device_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","operation":"telemetry_latest"}}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 200},
		{"nested wrong tool arguments", `{"tool":"query_structured_knowledge","args":{"device_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","operation":"telemetry_latest"}}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 502},
		{"nested injected authority", `{"tool":"query_structured_knowledge","args":{"query":"Count PDFs","tenant_id":"foreign"}}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 502},
		{"nested abstain", `{"tool":"abstain","args":{}}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 200},
		{"structured catalog", `{"tool":"query_structured_knowledge","query":"How many PDFs?","alert_id":"","device_id":"","note":"","etag":""}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 200},
		{"structured empty", `{"tool":"query_structured_knowledge","query":"","alert_id":"","device_id":"","note":"","etag":""}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 502},
		{"device latest unused known fields discarded", `{"tool":"query_device_facts","query":"","alert_id":"","device_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","note":"","etag":"","operation":"telemetry_latest","from":"unused","to":"unused","bucket":"unused"}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 200},
		{"device operation unknown rejected", `{"tool":"query_device_facts","query":"","alert_id":"","device_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","note":"","etag":"","operation":"latest","from":"","to":"","bucket":""}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 502},
		{"device rollup bounded", `{"tool":"query_device_facts","query":"","alert_id":"","device_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","note":"","etag":"","operation":"telemetry_rollups","from":"2026-10-01T00:00:00Z","to":"2026-10-02T00:00:00Z","bucket":"hour"}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 200},
		{"device risk unbounded rejected", `{"tool":"query_device_facts","query":"","alert_id":"","device_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","note":"","etag":"","operation":"risk_history","from":"2026-01-01T00:00:00Z","to":"2026-10-02T00:00:00Z","bucket":""}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 502},
		{"device target injection rejected", `{"tool":"query_device_facts","query":"","alert_id":"","device_id":"foreign","note":"","etag":"","operation":"telemetry_latest","from":"","to":"","bucket":""}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 502},
		{"knowledge", `{"tool":"search_knowledge","query":"grain moisture","alert_id":"","device_id":"","note":"","etag":""}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 200},
		{"decimal ETag normalization", `{"tool":"propose_acknowledge_alert","query":"","alert_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","device_id":"","note":"Reviewed","etag":"1"}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 200},
		{"safe abstention explanation", `{"tool":"abstain","query":"","alert_id":"","device_id":"","note":"Evidence is sufficient","etag":""}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 200},
		{"forbidden execution", `{"tool":"execute_alert","query":"","alert_id":"","device_id":"","note":"","etag":""}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 502},
		{"identity injection", `{"tool":"search_knowledge","query":"grain moisture","alert_id":"","device_id":"","note":"","etag":"","tenant_id":"foreign"}`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 502},
		{"cross tenant", `{}`, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": tc.output}}}})
			})
			req := httptest.NewRequest("POST", "/v1/agent/plan", strings.NewReader(`{"tenant_id":"`+tc.tenant+`","model":"answer-v1","question":"What grain moisture is recommended?"}`))
			req.Header.Set("Authorization", "Bearer "+token)
			res := httptest.NewRecorder()
			server.Handler().ServeHTTP(res, req)
			if res.Code != tc.want {
				t.Fatalf("%d %s", res.Code, res.Body.String())
			}
			if tc.name == "device latest unused known fields discarded" {
				var plan struct {
					Args map[string]any `json:"args"`
				}
				if err := json.Unmarshal(res.Body.Bytes(), &plan); err != nil || len(plan.Args) != 2 || plan.Args["operation"] != "telemetry_latest" {
					t.Fatal("latest forwarded unused range authority")
				}
			}
			if tc.want == 403 && calls != 0 {
				t.Fatal("cross tenant reached provider")
			}
		})
	}
}

func TestAgentFinalCitationContract(t *testing.T) {
	for _, tc := range []struct {
		output string
		want   int
	}{
		{`{"answer":"The alert is open.","cited_chunk_ids":["1"]}`, 200},
		{`{"answer":"Made up source.","cited_chunk_ids":["foreign"]}`, 502},
	} {
		server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
			json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": tc.output}}}})
		})
		req := httptest.NewRequest("POST", "/v1/agent/respond", strings.NewReader(`{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","model":"answer-v1","question":"What is the alert state?","observations":["Alert is open"]}`))
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, req)
		if res.Code != tc.want {
			t.Fatalf("%d %s", res.Code, res.Body.String())
		}
	}
}

func TestAgentPlanningNativeBranches(t *testing.T) {
	schema := agentPlanningSchema()
	if schema["additionalProperties"] != false {
		t.Fatal("root permits unknown fields")
	}
	branches := schema["properties"].(map[string]any)["plan"].(map[string]any)["anyOf"].([]any)
	if len(branches) != 9 {
		t.Fatalf("branches=%d", len(branches))
	}
	for _, value := range branches {
		branch := value.(map[string]any)
		props := branch["properties"].(map[string]any)
		tool := props["tool"].(map[string]any)["enum"].([]string)[0]
		args := props["args"].(map[string]any)
		fields := args["properties"].(map[string]any)
		if args["additionalProperties"] != false || branch["additionalProperties"] != false {
			t.Fatal("unbounded args")
		}
		if tool == "query_structured_knowledge" || tool == "search_knowledge" {
			if len(fields) != 1 || fields["query"] == nil {
				t.Fatal("catalog branch permits device fields")
			}
		}
		if tool == "query_device_facts" {
			operation := fields["operation"].(map[string]any)["enum"].([]string)[0]
			if fields["query"] != nil {
				t.Fatal("device branch permits catalog query")
			}
			if operation == "telemetry_latest" && len(fields) != 2 {
				t.Fatal("latest branch permits date fields")
			}
		}
	}
}
