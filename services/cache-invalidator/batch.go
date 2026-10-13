package main

import (
	"strconv"
	"time"
)

// batch coalesces notifications collected during one window into distinct bumps.
// A tenant bump supersedes that tenant's device bumps: the generation is part of every
// tenant key, so bumping it already invalidates device-scoped entries.
type batch struct {
	events, invalid int
	records         []Record
	tenants         map[string]Target
	devices         map[string]Target
	epoch           *Target
	watermarks      map[string]Target
	oldest          time.Time
}

func newBatch() *batch {
	return &batch{tenants: map[string]Target{}, devices: map[string]Target{}, watermarks: map[string]Target{}}
}

func (b *batch) add(r Record) {
	b.records = append(b.records, r)
	b.events++
	target, err := parseTarget(r.Value)
	if err != nil {
		b.invalid++
		return
	}
	if b.oldest.IsZero() || target.OccurredAt.Before(b.oldest) {
		b.oldest = target.OccurredAt
	}
	// Coalescing version bumps must not lose a device's higher required sequence
	// when a tenant/global invalidation supersedes it. Identities remain separate.
	if target.Incarnation != "" {
		key := target.Tenant + ":" + target.Incarnation + ":" + target.PlacementEpoch
		previous, exists := b.watermarks[key]
		sequence, _ := strconv.ParseInt(target.Sequence, 10, 64)
		old, _ := strconv.ParseInt(previous.Sequence, 10, 64)
		if !exists || sequence > old {
			// This maximum covers multiple device notifications. Publish it to
			// every tenant subscriber, never only the last selected device.
			hint := target
			hint.Scope = scopeTenant
			hint.Device = ""
			b.watermarks[key] = hint
		}
	}
	if target.Scope == scopeTenant {
		b.tenants[target.Tenant] = target
		return
	}
	if target.Scope == scopeEpoch {
		b.epoch = &target
		return
	}
	b.devices[target.Key()] = target
}

// targets returns the distinct bumps, dropping device bumps covered by a tenant bump.
func (b *batch) targets() []Target {
	if b.epoch != nil {
		return []Target{*b.epoch}
	}
	out := make([]Target, 0, len(b.tenants)+len(b.devices))
	for _, target := range b.tenants {
		out = append(out, target)
	}
	for _, target := range b.devices {
		if _, covered := b.tenants[target.Tenant]; !covered {
			out = append(out, target)
		}
	}
	return out
}
