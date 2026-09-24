package common

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
)

// RunMain gives worker services the same signal and error handling boundary.
func RunMain(run func(context.Context, func(string) string) error, exit func(int)) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Getenv); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("service stopped", "error", err)
		exit(1)
	}
}
