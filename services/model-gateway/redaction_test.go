package modelgateway

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRedactionPolicy(t *testing.T) {
	for _, value := range []string{"operator@example.invalid", "oper\u200bator@example.invalid", "ｏｐｅｒａｔｏｒ＠ｅｘａｍｐｌｅ．ｉｎｖａｌｉｄ", "204-555-1234", "sk-ant-" + strings.Repeat("x", 32), "pcsk_" + strings.Repeat("x", 32), "AKIA" + strings.Repeat("A", 16), "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature", "password=fictional-value", "Bearer fictional-token"} {
		safe := redactText(value)
		if strings.Contains(safe, value) || redactText(safe) != safe {
			t.Fatal("redaction policy failure")
		}
	}
	benign := "Moisture 13.5%, 20 C, 2026-10-01 document aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa page 12."
	if redactText(benign) != benign {
		t.Fatal("changed agronomic values")
	}
	for _, text := range redactPassages([]string{"-----BEGIN PRIVATE KEY-----", "sensitive", "-----END PRIVATE KEY-----"}) {
		if text != "[REDACTED_PRIVATE_KEY]" {
			t.Fatal("split key leaked")
		}
	}
}

func TestRedactionProviderBoundaries(t *testing.T) {
	for _, path := range []string{"/v1/embeddings", "/v1/rerank", "/v1/answers"} {
		calls := 0
		server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
			calls++
			body, _ := io.ReadAll(r.Body)
			if strings.Contains(string(body), "operator@example.invalid") {
				t.Error("private email reached provider")
			}
			switch path {
			case "/v1/embeddings":
				io.WriteString(w, `{"data":[{"index":0,"embedding":[1,2]}]}`)
			case "/v1/rerank":
				io.WriteString(w, `{"choices":[{"message":{"content":"{\"results\":[{\"index\":0,\"relevance_score\":1}]}"}}]}`)
			case "/v1/answers":
				io.WriteString(w, `{"choices":[{"message":{"content":"{\"answer\":\"Contact operator@example.invalid\",\"cited_chunk_ids\":[\"chunk-1\"]}"}}]}`)
			}
		})
		body := `{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",`
		switch path {
		case "/v1/embeddings":
			body += `"model":"embed-v1","input":["operator@example.invalid"],"input_type":"passage"}`
		case "/v1/rerank":
			body += `"model":"rerank-v1","query":"Contact operator@example.invalid?","documents":["Contact operator@example.invalid"],"top_n":1}`
		case "/v1/answers":
			body += `"model":"answer-v1","question":"Contact operator@example.invalid?","context":[{"chunk_id":"chunk-1","text":"Contact operator@example.invalid"}]}`
		}
		req := httptest.NewRequest("POST", path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		out := httptest.NewRecorder()
		server.Handler().ServeHTTP(out, req)
		if calls != 1 || out.Code != 200 || strings.Contains(out.Body.String(), "operator@example.invalid") {
			t.Fatalf("%s failed: %d %s", path, out.Code, out.Body.String())
		}
	}
}

func TestControlsRejectInsecureRemoteRedis(t *testing.T) {
	path := filepath.Join(t.TempDir(), "controls.json")
	if err := os.WriteFile(path, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	for _, url := range []string{"redis://cache.example.invalid:6379", "rediss://cache.example.invalid:6379?skip_verify=true"} {
		_, closeFn, err := OpenControls(context.Background(), path, url, "postgres://unused")
		if closeFn != nil {
			closeFn()
		}
		if err == nil || err.Error() != "Redis TLS required outside loopback" {
			t.Fatal("insecure remote Redis was not rejected before connection")
		}
	}
}

func TestPrivateKeyEmbeddingsBlockedBeforeProvider(t *testing.T) {
	for _, marker := range []string{"-----BEGIN PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----", "-----BEGIN PRIVATE\u200b KEY-----"} {
		calls := 0
		server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) { calls++ })
		req := httptest.NewRequest("POST", "/v1/embeddings", strings.NewReader(`{"tenant_id":"`+testTenant+`","model":"embed-v1","input_type":"passage","input":["`+marker+`","secret"]}`))
		req.Header.Set("Authorization", "Bearer "+token)
		result := httptest.NewRecorder()
		server.Handler().ServeHTTP(result, req)
		if result.Code != 422 || calls != 0 || !strings.Contains(result.Body.String(), "private_key_blocked") {
			t.Fatalf("private key escaped: %d calls=%d", result.Code, calls)
		}
	}
}
