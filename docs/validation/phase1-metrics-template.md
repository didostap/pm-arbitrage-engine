# Phase 1 Metrics Collection Template — Read-Only Detection Validation

**Created:** 2026-02-28
**Phase:** Phase 1 (Read-Only Detection)
**Duration:** 48 hours minimum
**Related:** [Phase 2 Metrics](./phase2-metrics-template.md) | [Go/No-Go Criteria](./go-no-go-criteria.md) | [Observation Log](./observation-log-template.md)

---

## How to Use This Template

1. Start Phase 1 with the engine running in **detection-only mode** (no execution).
2. Collect **per-cycle metrics** from structured JSON logs using the `jq` commands below.
3. At the end of each day, compute **daily aggregates** using the provided SQL queries and shell scripts.
4. Record results in a copy of the tables below (one per day).
5. After 48h, evaluate against [Phase 1 Go/No-Go Criteria](./go-no-go-criteria.md#phase-1--phase-2-gate).

---

## Per-Cycle Metrics

Captured automatically by structured JSON logs. Extract after each cycle or in batch at end of day.

| Column | Description | Source | Collection Method |
|--------|-------------|--------|-------------------|
| `timestamp` | Cycle start time (ISO 8601) | Pino structured log | `jq 'select(.msg == "Detection cycle complete") \| .time'` |
| `cycle_number` | Sequential cycle count | Pino structured log | `jq 'select(.msg == "Detection cycle complete") \| .data.cycleNumber'` |
| `opportunities_found` | Number of opportunities detected this cycle | Pino structured log | `jq 'select(.msg == "Detection cycle complete") \| .data.dislocationsFound'` |
| `edge_values` | Comma-separated list of detected edges | Event payload (`detection.opportunity.identified`) | `jq 'select(.msg == "detection.opportunity.identified") \| .data.edge'` |
| `max_edge` | Highest edge value in this cycle | Derived from `edge_values` | Computed from edge_values column |
| `detection_latency_ms` | Time to complete detection cycle (ms) | Pino structured log | `jq 'select(.msg == "Detection cycle complete") \| .data.durationMs'` |
| `kalshi_health` | Kalshi platform status | Pino structured log | `jq 'select(.msg == "platform.health.updated" and .data.platform == "KALSHI") \| .data.status'` |
| `polymarket_health` | Polymarket platform status | Pino structured log | `jq 'select(.msg == "platform.health.updated" and .data.platform == "POLYMARKET") \| .data.status'` |
| `kalshi_book_depth` | Total bid+ask levels across configured Kalshi pairs | Pino structured log (ingestion) | `jq 'select(.msg == "orderbook.updated" and .data.platform == "KALSHI") \| .data.bidLevels + .data.askLevels'` |
| `polymarket_book_depth` | Total bid+ask levels across configured Polymarket pairs | Pino structured log (ingestion) | `jq 'select(.msg == "orderbook.updated" and .data.platform == "POLYMARKET") \| .data.bidLevels + .data.askLevels'` |

### Per-Cycle Data Extraction Command

Extract all per-cycle data for a given day from pm2 logs:

```bash
# Export pm2 logs to file first
pm2 logs pm-arbitrage-engine --nostream --lines 100000 --json > /tmp/day-N-logs.json

# Detection cycles
cat /tmp/day-N-logs.json | jq -r '
  select(.msg == "Detection cycle complete") |
  [.time, .data.cycleNumber, .data.dislocationsFound, .data.durationMs] |
  @csv
' > /tmp/day-N-cycles.csv

# Opportunities detected (with edge values)
cat /tmp/day-N-logs.json | jq -r '
  select(.msg == "detection.opportunity.identified") |
  [.time, .data.edge, .data.pairId] |
  @csv
' > /tmp/day-N-opportunities.csv
```

---

## Daily Aggregate Metrics

Compute at the end of each day from per-cycle data. One row per day.

| Column | Description | Calculation |
|--------|-------------|-------------|
| `date` | Date (YYYY-MM-DD) | Calendar date |
| `total_cycles` | Total detection cycles run | `wc -l < /tmp/day-N-cycles.csv` |
| `total_opportunities` | Total opportunities detected | `wc -l < /tmp/day-N-opportunities.csv` |
| `edge_min` | Minimum edge detected | `awk -F',' '{print $2}' /tmp/day-N-opportunities.csv \| sort -n \| head -1` |
| `edge_median` | Median edge detected | Sort edge_values, take middle value |
| `edge_max` | Maximum edge detected | `awk -F',' '{print $2}' /tmp/day-N-opportunities.csv \| sort -n \| tail -1` |
| `edge_mean` | Mean edge detected | `awk -F',' '{sum+=$2; n++} END {print sum/n}' /tmp/day-N-opportunities.csv` |
| `latency_p50_ms` | 50th percentile detection latency | Sort latency values, take 50th percentile |
| `latency_p95_ms` | 95th percentile detection latency | Sort latency values, take 95th percentile |
| `latency_p99_ms` | 99th percentile detection latency | Sort latency values, take 99th percentile |
| `kalshi_uptime_pct` | Kalshi uptime percentage | See SQL query below |
| `polymarket_uptime_pct` | Polymarket uptime percentage | See SQL query below |
| `unhandled_errors_count` | Unhandled exceptions/crashes | `pm2 show pm-arbitrage-engine \| grep "restart time"` + log scan |
| `degradation_events_count` | Degradation protocol activations | `jq 'select(.msg == "degradation.protocol.activated")' \| wc -l` |

### Daily Aggregate Computation Scripts

**Latency percentiles:**
```bash
# Extract latencies, sort, compute percentiles
cat /tmp/day-N-cycles.csv | awk -F',' '{print $4}' | sort -n > /tmp/latencies-sorted.txt
TOTAL=$(wc -l < /tmp/latencies-sorted.txt)
P50=$(sed -n "$((TOTAL * 50 / 100))p" /tmp/latencies-sorted.txt)
P95=$(sed -n "$((TOTAL * 95 / 100))p" /tmp/latencies-sorted.txt)
P99=$(sed -n "$((TOTAL * 99 / 100))p" /tmp/latencies-sorted.txt)
echo "p50=${P50}ms p95=${P95}ms p99=${P99}ms"
```

**Platform uptime percentage (SQL via psql):**
```sql
-- Kalshi uptime over the last 24 hours
-- Uses transition-only health log persistence (Story 6.5.2a)
-- Uptime = time in 'healthy' state / total time
SELECT
  platform,
  ROUND(
    100.0 * SUM(
      CASE WHEN status = 'healthy'
        THEN EXTRACT(EPOCH FROM (
          COALESCE(LEAD(created_at) OVER (PARTITION BY platform ORDER BY created_at), NOW()) - created_at
        ))
        ELSE 0
      END
    ) / EXTRACT(EPOCH FROM (NOW() - (NOW() - INTERVAL '24 hours'))),
    1
  ) AS uptime_pct
FROM platform_health_logs
WHERE created_at >= NOW() - INTERVAL '24 hours'
GROUP BY platform;
```

---

## Daily Recording Table

Copy this table for each day of Phase 1 validation.

### Day N — YYYY-MM-DD

| Metric | Value |
|--------|-------|
| Total cycles | |
| Total opportunities | |
| Edge min | |
| Edge median | |
| Edge max | |
| Edge mean | |
| Latency p50 (ms) | |
| Latency p95 (ms) | |
| Latency p99 (ms) | |
| Kalshi uptime % | |
| Polymarket uptime % | |
| Unhandled errors | |
| Degradation events | |

---

## Event-to-Metric Mapping

| Metric Category | Domain Event | Event Name Constant |
|----------------|--------------|---------------------|
| Opportunities detected | `detection.opportunity.identified` | `EVENT_NAMES.OPPORTUNITY_IDENTIFIED` |
| Opportunities filtered | `detection.opportunity.filtered` | `EVENT_NAMES.OPPORTUNITY_FILTERED` |
| Platform health changes | `platform.health.degraded` | `EVENT_NAMES.PLATFORM_HEALTH_DEGRADED` |
| Platform recovery | `platform.health.recovered` | `EVENT_NAMES.PLATFORM_HEALTH_RECOVERED` |
| Platform disconnect | `platform.health.disconnected` | `EVENT_NAMES.PLATFORM_HEALTH_DISCONNECTED` |
| Degradation protocol | `degradation.protocol.activated` | `EVENT_NAMES.DEGRADATION_PROTOCOL_ACTIVATED` |
| Degradation recovery | `degradation.protocol.deactivated` | `EVENT_NAMES.DEGRADATION_PROTOCOL_DEACTIVATED` |
| Data staleness | `platform.health.data-stale` | `EVENT_NAMES.DATA_STALE` |
| Time drift warning | `time.drift.warning` | `EVENT_NAMES.TIME_DRIFT_WARNING` |
| Trading halt | `system.trading.halted` | `EVENT_NAMES.SYSTEM_TRADING_HALTED` |

---

## Notes

- **Pino JSON field name:** Production JSON output uses `msg` (not `message`) as the log message field. All `jq` filters use `.msg` for message matching.
- **Data sub-object:** The `data` sub-object retains field names as-is (e.g., `.data.durationMs`, `.data.dislocationsFound`).
- **Log export:** Use `pm2 logs pm-arbitrage-engine --nostream --lines N --json` to export logs for analysis.
- **Health log persistence:** Platform health logs use transition-only persistence (Story 6.5.2a) — only state changes are recorded, not periodic updates.
