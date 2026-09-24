package common

import (
	"context"
	"net"
	"net/http"
)

// RunHTTP wires a service handler to its configurable listener and worker loop.
func RunHTTP(ctx context.Context, getenv func(string) string, defaultAddr string, handler http.Handler,
	listen func(string, string) (net.Listener, error), serve func(context.Context, *http.Server, net.Listener) error) error {
	addr := getenv("HTTP_ADDR")
	if addr == "" {
		addr = defaultAddr
	}
	server := HTTPServer(addr, handler)
	listener, err := listen("tcp", addr)
	if err != nil {
		return err
	}
	return serve(ctx, server, listener)
}
