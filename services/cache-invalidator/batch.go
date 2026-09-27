package main

import "time"

// batch coalesces notifications collected during one window into distinct bumps.
// A tenant bump supersedes that tenant's device bumps: the generation is part of every
// tenant key, so bumping it already invalidates device-scoped entries.
type batch struct {
	events, invalid int
	records         []Record
	tenants         map[string]Target
	devices         map[string]Target
	epoch           *Target
	oldest          time.Time
}

func newBatch() *batch {
	return &batch{tenants: map[string]Target{}, devices: map[string]Target{}}
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
