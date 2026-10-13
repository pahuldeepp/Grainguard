package modelgateway

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testServer(t *testing.T, provider http.HandlerFunc) (*Server, string) {
	t.Helper()
	upstream := httptest.NewServer(provider)
	t.Cleanup(upstream.Close)
	token := "local-service-token"
	digest := sha256.Sum256([]byte(token))
	server, err := New(Config{ProviderURL: upstream.URL, ProviderKey: "provider-key", Timeout: time.Second,
		TokenHashes:     map[string]Caller{hex.EncodeToString(digest[:]): {TenantID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Scopes: []string{"knowledge:embed", "knowledge:rerank", "knowledge:answer"}}},
		EmbeddingModels: map[string]string{"embed-v1": "embed-provider"},
		RerankerModels:  map[string]string{"rerank-v1": "rerank-provider"},
		AnswerModels:    map[string]string{"answer-v1": "answer-provider"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return server, token
}

func TestCallerDeadlineBounds(t *testing.T) {
	server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("invalid embedding body must not reach provider")
	})
	for _, value := range []string{"120000", "120001", "0", "-1", "invalid"} {
		t.Run(value, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/v1/embeddings", strings.NewReader(`{}`))
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("X-AI-Timeout-Ms", value)
			out := httptest.NewRecorder()
			server.Handler().ServeHTTP(out, req)
			invalidDeadline := strings.Contains(out.Body.String(), "invalid_deadline")
			if invalidDeadline != (value != "120000") {
				t.Fatalf("unexpected deadline validation for %s: %s", value, out.Body.String())
			}
		})
	}
}

func TestEmbeddingRouteUsesAllowlistedModelAndProvider(t *testing.T) {
	server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/embeddings" || r.Header.Get("Authorization") != "Bearer provider-key" {
			t.Errorf("unexpected upstream request: %s", r.URL.Path)
		}
		var body struct {
			Model string   `json:"model"`
			Input []string `json:"input"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Model != "embed-provider" || len(body.Input) != 2 {
			t.Errorf("unexpected provider body: %+v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"index":0,"embedding":[0.1,0.2]},{"index":1,"embedding":[0.3,0.4]}]}`))
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","model":"embed-v1","input":["one","two"],"input_type":"passage"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"embedding":[0.1,0.2]`) {
		t.Fatalf("got %d %s", res.Code, res.Body.String())
	}
}

func TestCallerScopeModelAndCitationValidation(t *testing.T) {
	server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/embeddings" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":[{"index":0,"embedding":[0.1,0.2]}]}`))
			return
		}
		if r.URL.Path != "/chat/completions" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		var body struct {
			Model    string `json:"model"`
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		content := `{"results":[{"index":1,"score":0.9},{"index":0,"score":0.4}]}`
		if strings.Contains(body.Messages[0].Content, "Answer only") {
			content = `{"answer":"Use dry storage.","cited_chunk_ids":["chunk-1"]}`
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": content}}}})
	})
	// Unknown identities are denied before provider egress.
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","model":"missing","input":["x"],"input_type":"query"}`))
	req.Header.Set("Authorization", "Bearer invalid")
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != 401 {
		t.Fatalf("unknown caller: got %d", res.Code)
	}
	// A valid token cannot select models outside the server route table.
	req = httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","model":"missing","input":["x"],"input_type":"query"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	res = httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != 400 {
		t.Fatalf("unknown model: %d %s", res.Code, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/v1/answers", strings.NewReader(`{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","model":"answer-v1","question":"What?","context":[{"chunk_id":"chunk-1","trust":"curated","text":"Evidence."}],"citation_contract":"Use IDs"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	res = httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != 200 {
		t.Fatalf("answer: %d %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "chunk-1") {
		t.Fatal("answer did not preserve validated citation")
	}

	// A provider cannot cite a chunk outside the supplied context.
	bad, _ := testServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"answer\":\"bad\",\"cited_chunk_ids\":[\"other\"]}"}}]}`))
	})
	req = httptest.NewRequest(http.MethodPost, "/v1/answers", strings.NewReader(`{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","model":"answer-v1","question":"What?","context":[{"chunk_id":"chunk-1","trust":"curated","text":"Evidence."}],"citation_contract":"Use IDs"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	res = httptest.NewRecorder()
	bad.Handler().ServeHTTP(res, req)
	if res.Code != 502 {
		t.Fatalf("untrusted citation: got %d", res.Code)
	}
}

func TestRejectsUnsafeProviderURL(t *testing.T) {
	_, err := New(Config{ProviderURL: "http://example.com", ProviderKey: "k", TokenHashes: map[string]Caller{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": {TenantID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Scopes: []string{"knowledge:embed"}}}, EmbeddingModels: map[string]string{"e": "e"}, RerankerModels: map[string]string{"r": "r"}, AnswerModels: map[string]string{"a": "a"}})
	if err == nil {
		t.Fatal("accepted plaintext non-loopback provider URL")
	}
}

func TestTenantBindingAndScopeAreCheckedBeforeProviderEgress(t *testing.T) {
	var called atomic.Bool
	server, token := testServer(t, func(w http.ResponseWriter, _ *http.Request) {
		called.Store(true)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"index":0,"embedding":[0.1]}]}`))
	})

	request := func(tenant string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"tenant_id":"`+tenant+`","model":"embed-v1","input":["text"],"input_type":"query"}`))
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, req)
		return res
	}
	if got := request("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").Code; got != 403 {
		t.Fatalf("cross-tenant request got %d", got)
	}
	if called.Load() {
		t.Fatal("provider called for a tenant mismatch")
	}

	// A separate valid caller is intentionally limited to answer-only scope.
	digest := sha256.Sum256([]byte("answer-only"))
	scoped, err := New(Config{
		ProviderURL: "http://127.0.0.1:1", ProviderKey: "key",
		TokenHashes: map[string]Caller{hex.EncodeToString(digest[:]): {
			TenantID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Scopes: []string{"knowledge:answer"},
		}}, EmbeddingModels: map[string]string{"embed-v1": "provider-embed"},
		RerankerModels: map[string]string{"rerank-v1": "provider-rerank"},
		AnswerModels:   map[string]string{"answer-v1": "provider-answer"},
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", strings.NewReader(`{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","model":"embed-v1","input":["text"],"input_type":"query"}`))
	req.Header.Set("Authorization", "Bearer answer-only")
	res := httptest.NewRecorder()
	scoped.Handler().ServeHTTP(res, req)
	if res.Code != 403 {
		t.Fatalf("wrong scope got %d", res.Code)
	}
}

func TestNativeProviderProtocols(t *testing.T) {
	server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		switch r.URL.Path {
		case "/embeddings":
			if body["input_type"] != "document" || body["output_dimension"] != float64(2) || body["truncation"] != false {
				t.Errorf("incorrect Voyage embedding options")
			}
			if r.Header.Get("Authorization") != "Bearer voyage-key" {
				t.Error("wrong Voyage credential")
			}
			_, _ = w.Write([]byte(`{"data":[{"index":0,"embedding":[0.1,0.2]}]}`))
		case "/rerank":
			if body["top_k"] != float64(1) || body["return_documents"] != false {
				t.Error("wrong native rerank contract")
			}
			_, _ = w.Write([]byte(`{"data":[{"index":0,"relevance_score":0.95}]}`))
		case "/messages":
			if r.Header.Get("x-api-key") != "anthropic-key" || r.Header.Get("anthropic-version") != "2023-06-01" || r.Header.Get("Authorization") != "" {
				t.Error("credential isolation failed")
			}
			format, ok := body["output_config"].(map[string]any)["format"].(map[string]any)
			if !ok || format["type"] != "json_schema" {
				t.Error("Claude answer request must use structured JSON output")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"stop_reason": "end_turn", "content": []any{map[string]string{"type": "text", "text": `{"answer":"Dry grain.","cited_chunk_ids":["c1"]}`}}})
		default:
			t.Errorf("unexpected native path %s", r.URL.Path)
		}
	})
	config := server.config
	config.VoyageURL = config.ProviderURL
	config.VoyageKey = "voyage-key"
	config.AnthropicURL = config.ProviderURL
	config.AnthropicKey = "anthropic-key"
	config.EmbeddingDimension = 2
	var err error
	server, err = New(config)
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct{ path, body string }{
		{"/v1/embeddings", `{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","model":"embed-v1","input":["Dry grain"],"input_type":"passage"}`},
		{"/v1/rerank", `{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","model":"rerank-v1","query":"Storage?","documents":["Dry grain"],"top_n":1}`},
		{"/v1/answers", `{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","model":"answer-v1","question":"Storage?","context":[{"chunk_id":"c1","trust":"curated","text":"Dry grain."}]}`},
	} {
		req := httptest.NewRequest("POST", tc.path, strings.NewReader(tc.body))
		req.Header.Set("Authorization", "Bearer "+token)
		out := httptest.NewRecorder()
		server.Handler().ServeHTTP(out, req)
		if out.Code != 200 {
			t.Fatalf("%s: %d %s", tc.path, out.Code, out.Body.String())
		}
	}
}

func TestAnthropicConfigurationCannotBypassURLValidation(t *testing.T) {
	s, _ := testServer(t, func(http.ResponseWriter, *http.Request) {})
	for _, endpoint := range []string{"http://example.com", "https://example.com/?key=x"} {
		c := s.config
		c.AnthropicURL = endpoint
		c.AnthropicKey = "secret"
		if _, err := New(c); err == nil {
			t.Fatal("accepted unsafe Anthropic endpoint")
		}
	}
	c := s.config
	c.AnthropicURL = "https://api.anthropic.com/v1"
	if _, err := New(c); err == nil {
		t.Fatal("accepted missing Anthropic credential")
	}
}

func TestInsufficientEvidenceCanReturnEmptyCitationList(t *testing.T) {
	s, token := testServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": `{"answer":"Insufficient evidence.","cited_chunk_ids":[]}`}}}})
	})
	r := httptest.NewRequest("POST", "/v1/answers", strings.NewReader(`{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","model":"answer-v1","question":"What?","context":[{"chunk_id":"c","text":"Limited evidence."}]}`))
	r.Header.Set("Authorization", "Bearer "+token)
	out := httptest.NewRecorder()
	s.Handler().ServeHTTP(out, r)
	if out.Code != 200 || !strings.Contains(out.Body.String(), `"cited_chunk_ids":[]`) {
		t.Fatalf("abstention: %d %s", out.Code, out.Body.String())
	}
	s.BeginDrain()
	out = httptest.NewRecorder()
	s.Handler().ServeHTTP(out, httptest.NewRequest("GET", "/healthz", nil))
	if out.Code != 503 {
		t.Fatal("draining instance remained ready")
	}
}

func TestProviderThrottlePreservesRetryAfterWithoutRetryStorm(t *testing.T) {
	for _, retry := range []string{"37", ""} {
		var calls atomic.Int32
		s, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			if retry != "" {
				w.Header().Set("Retry-After", retry)
			}
			w.WriteHeader(http.StatusTooManyRequests)
		})
		for i := 0; i < 2; i++ {
			r := httptest.NewRequest("POST", "/v1/embeddings", strings.NewReader(`{"tenant_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","model":"embed-v1","input_type":"query","input":["test"]}`))
			r.Header.Set("Authorization", "Bearer "+token)
			out := httptest.NewRecorder()
			s.Handler().ServeHTTP(out, r)
			want := retry
			if want == "" {
				want = "60"
			}
			if out.Code != 429 || out.Header().Get("Retry-After") != want || !strings.Contains(out.Body.String(), "provider_rate_limited") {
				t.Fatalf("throttle lost: %d retry=%s body=%s", out.Code, out.Header().Get("Retry-After"), out.Body.String())
			}
		}
		if calls.Load() != 2 {
			t.Fatal("throttle retried unexpectedly")
		}
	}
}
