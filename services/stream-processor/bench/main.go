// Benchmark helpers for the optional Flink job (ADR-0030). `gen` writes a deterministic canonical telemetry
// workload; `baseline` is an in-memory Go consumer that does the same derivation as the Flink job (dedupe, 15m/1m
// sliding aggregates, EWMA anomaly detection) in either the repository's existing one-record-at-a-time style or a
// batched style. The baseline has no checkpointing, no late-data handling and skips most validation, so it is a
// speed reference, not a fault-tolerant equivalent.
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: bench gen|baseline [flags]")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "gen":
		err = runGen(os.Args[2:])
	case "baseline":
		err = runBaseline(os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
