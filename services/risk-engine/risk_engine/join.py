"""Event-time selection of the grain lot a reading belongs to.

The lot is the one occupying the reading's bin at ``observed_at`` (half-open
``[effective_from, effective_to)``, the device-service exclusion range), never the lot
present when Kafka happens to deliver the reading. Missing, overlapping or possibly
stale context is NOT READY: retryable, never scored with a guessed crop.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Sequence

BINDING_STATE_UNAVAILABLE = "binding_state_unavailable"
LOT_STATE_UNAVAILABLE = "lot_state_unavailable"
LOT_FEED_STALE = "lot_feed_stale"


@dataclass(frozen=True)
class Binding:
    device_id: str
    site_id: str | None
    bin_id: str | None
    status: str | None
    inventory_version: int
    binding_version: int


@dataclass(frozen=True)
class Interval:
    bin_id: str
    occupancy_version: int
    lot_id: str
    grain_type: str
    effective_from: datetime
    effective_to: datetime | None


@dataclass(frozen=True)
class Reading:
    bin_id: str | None
    binding_version: int
    observed_at: datetime


@dataclass(frozen=True)
class Selected:
    interval: Interval


@dataclass(frozen=True)
class NotReady:
    """Context has not arrived (yet); the offset must not be committed."""

    reason: str


@dataclass(frozen=True)
class Skip:
    """Nothing to score, by design (for example a device that is not in a bin)."""

    reason: str


@dataclass(frozen=True)
class Reject:
    """Context contradicts the reading; quarantine with a stable reason."""

    reason: str


def covers(interval: Interval, instant: datetime) -> bool:
    return interval.effective_from <= instant and (
        interval.effective_to is None or instant < interval.effective_to)


def select_lot(reading: Reading, binding: Binding | None, intervals: Sequence[Interval],
               lot_feed_watermark: datetime | None) -> Selected | NotReady | Skip | Reject:
    """Choose the lot for one reading.

    ``lot_feed_watermark`` is the source time up to which every lot change is known to
    be applied locally. An open interval (no successor yet) is trusted only up to it,
    because a replacement committed before the reading may still be in flight.
    """
    if reading.bin_id is None:
        return Skip("device_unbound")
    if binding is None or binding.binding_version < reading.binding_version:
        return NotReady(BINDING_STATE_UNAVAILABLE)
    if binding.binding_version == reading.binding_version and binding.bin_id != reading.bin_id:
        return Reject("binding_conflict")
    matches = [i for i in intervals if i.bin_id == reading.bin_id and covers(i, reading.observed_at)]
    if len(matches) != 1:
        return NotReady(LOT_STATE_UNAVAILABLE)
    chosen = matches[0]
    if chosen.effective_to is None and (
            lot_feed_watermark is None or lot_feed_watermark < reading.observed_at):
        return NotReady(LOT_FEED_STALE)
    return Selected(chosen)
