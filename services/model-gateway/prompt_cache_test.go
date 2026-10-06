package modelgateway

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTrustedCacheBoundary(t *testing.T) {
	task := "tenant-specific evidence must remain outside breakpoint"
	blocks := cachedSystemBlocks(task)
	if len(blocks) != 2 || blocks[0]["text"] != trustedAssistantProtocol || blocks[1]["text"] != task {
		t.Fatal("invalid block boundary")
	}
	if _, exists := blocks[1]["cache_control"]; exists {
		t.Fatal("dynamic instructions cached")
	}
	if strings.Contains(trustedAssistantProtocol, task) {
		t.Fatal("task leaked into shared protocol")
	}
	cache := blocks[0]["cache_control"].(map[string]string)
	if cache["type"] != "ephemeral" || cache["ttl"] != "5m" {
		t.Fatal("unexpected cache contract")
	}
}

func TestCachedUsageAndReservation(t *testing.T) {
	raw := []byte(`{"usage":{"input_tokens":100,"output_tokens":20,"cache_creation_input_tokens":1000,"cache_read_input_tokens":2000}}`)
	input, output, known := measuredUsage(raw, true)
	if !known || input != 3100 || output != 20 {
		t.Fatalf("cached quota accounting %d %d %t", input, output, known)
	}
	price := Price{InputMicrosPerMillion: 1000000, OutputMicrosPerMillion: 1000000}
	if got := cacheSettlementCost(raw, input, output, price, true); got != 1570 {
		t.Fatalf("cache creation surcharge missing %d", got)
	}
	if got := cacheReservationCost(100, 20, price, true); got != 145 {
		t.Fatalf("reservation misses surcharge %d", got)
	}
	for _, bad := range []string{`{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":-1}`, `{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":-1}`, `{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":9223372036854775807}`} {
		_, _, valid := measuredUsage([]byte(`{"usage":`+bad+`}`), true)
		if valid {
			t.Fatal("invalid cache usage accepted")
		}
	}
	fractional := []byte(`{"usage":{"cache_creation_input_tokens":1,"cache_read_input_tokens":1}}`)
	if got := cacheSettlementCost(fractional, 2, 0, Price{InputMicrosPerMillion: 3000000}, true); got != 5 {
		t.Fatalf("final microcurrency ceil must preserve fractional rates: %d", got)
	}
	// Missing cache fields on legacy Anthropic responses mean zero cached tokens.
	encoded, _ := json.Marshal(map[string]any{"usage": map[string]int{"input_tokens": 1, "output_tokens": 2}})
	i, o, k := measuredUsage(encoded, true)
	if !k || i != 1 || o != 2 {
		t.Fatal("legacy usage broken")
	}
}
