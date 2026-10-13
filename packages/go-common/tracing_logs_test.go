package common

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
)

func TestThresholdHandlerKeepsConsolePolicySeparateFromOTLP(t *testing.T) {
	var output bytes.Buffer
	remote := thresholdHandler{handler: slog.NewTextHandler(&output, nil), min: slog.LevelWarn}
	logger := slog.New(remote)
	logger.Info("routine event")
	logger.Warn("action needed")
	if strings.Contains(output.String(), "routine event") || !strings.Contains(output.String(), "action needed") {
		t.Fatalf("WARN+ filter output = %q", output.String())
	}
	if !remote.Enabled(context.Background(), slog.LevelWarn) || remote.Enabled(context.Background(), slog.LevelInfo) {
		t.Fatal("threshold Enabled did not enforce WARN minimum")
	}
}
