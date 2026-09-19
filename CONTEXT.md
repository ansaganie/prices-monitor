# price-monitor

A zero-server monitor that polls a source API on a schedule and tells a Telegram chat when a tracked listing's price or availability is worth a look. Today the only integration is BI Group's parking sales-picker API, tracking two of their residential complexes — but the service itself is provider-agnostic in intent: see [[0003-scope-bi-group-rebrand-to-docs]] for what that does and doesn't mean yet.

## Language

**Monitored Object**:
One listing group being tracked end to end — a config entry, a source-API query, and a line of its own in every report. Today each Object is one BI Group residential complex's parking inventory.
_Avoid_: "real-estate object" (ties the concept to BI Group specifically, which is no longer accurate framing)

**Placement**:
A single sellable unit (one parking spot) the source API returns for a Monitored Object.

**Send Trigger**:
One of the three independent conditions under which a run sends a Telegram message: Daily Digest, Change Alert, or Run-Gap Watchdog. Multiple triggers firing on the same run merge into one message rather than sending separately.
_Avoid_: sending unconditionally every run (the old behavior this concept replaced)

**Daily Digest**:
The Send Trigger that fires once per Astana calendar day, on the first run where local time is ≥13:00 — a full status report of every Monitored Object regardless of whether anything changed. See [[0002-baseline-diff-notification-triggers]].

**Change Alert**:
The Send Trigger that fires when a Monitored Object's current min available price or available-unit count differs, in either direction, from its Reported Baseline. See [[0002-baseline-diff-notification-triggers]].

**Reported Baseline**:
The min-price/available-count values from the last message actually sent for a Monitored Object (Daily Digest or Change Alert) — not the values from the most recent fetch. A run that observes a change but doesn't yet send anything (impossible today, since any observed change is itself send-worthy, but relevant for reasoning about the diff) would not move the baseline.
_Avoid_: comparing against "the previous run's value" — a rejected alternative, see [[0002-baseline-diff-notification-triggers]]

**Crossing Event**:
A Change Alert where the Reported Baseline was on one side of `PRICE_FLOOR` or `AVAILABILITY_THRESHOLD` and the new value is on the other. Marked with 🔥 in the message. A one-time event on the message that reports it, not a persistent "still low" status shown on every subsequent send.

**Run-Gap Watchdog**:
The Send Trigger that fires when more than 90 minutes have passed since the previous run — an early warning that the external-cron guarantee (see ADR 0001) has silently broken.
