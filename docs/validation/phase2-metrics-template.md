# Phase 2 Metrics Collection Template — Paper Execution Validation

**Created:** 2026-02-28
**Phase:** Phase 2 (Paper Execution)
**Duration:** 5 days minimum
**Extends:** [Phase 1 Metrics](./phase1-metrics-template.md) (all Phase 1 metrics continue to be collected)
**Related:** [Go/No-Go Criteria](./go-no-go-criteria.md) | [Observation Log](./observation-log-template.md)

---

## How to Use This Template

1. Phase 2 runs in **paper trading mode** — real market data, simulated execution via `PaperTradingConnector`.
2. Continue collecting all [Phase 1 metrics](./phase1-metrics-template.md).
3. Additionally collect the **execution**, **risk**, **monitoring**, and **resilience** metrics below.
4. At the end of each day, compute daily aggregates.
5. After 5 days, evaluate against [Phase 2 Go/No-Go Criteria](./go-no-go-criteria.md#phase-2--epic-7-gate).

---

## Execution Metrics

| Column | Description | Source | Collection Method |
|--------|-------------|--------|-------------------|
| `paper_orders_submitted` | Total paper orders submitted | `orders` table | `SELECT COUNT(*) FROM orders WHERE created_at >= NOW() - INTERVAL '1 day';` |
| `paper_orders_filled` | Paper orders with FILLED status | `orders` table | `SELECT COUNT(*) FROM orders WHERE status = 'FILLED' AND created_at >= NOW() - INTERVAL '1 day';` |
| `fill_latency_ms` | Time from order submission to simulated fill | Pino structured log | `jq 'select(.msg == "execution.order.filled") \| .data.fillLatencyMs'` |
| `positions_opened` | Positions opened (status = OPEN) | `open_positions` table | `SELECT COUNT(*) FROM open_positions WHERE status = 'OPEN' AND created_at >= NOW() - INTERVAL '1 day';` |
| `positions_exited` | Positions closed/exited | `open_positions` table | `SELECT COUNT(*) FROM open_positions WHERE status = 'CLOSED' AND updated_at >= NOW() - INTERVAL '1 day';` |
| `exit_trigger_take_profit` | Exits triggered by take-profit | Pino structured log | `jq 'select(.msg == "execution.exit.triggered" and .data.triggerType == "TAKE_PROFIT")' \| wc -l` |
| `exit_trigger_stop_loss` | Exits triggered by stop-loss | Pino structured log | `jq 'select(.msg == "execution.exit.triggered" and .data.triggerType == "STOP_LOSS")' \| wc -l` |
| `exit_trigger_time_based` | Exits triggered by time expiry | Pino structured log | `jq 'select(.msg == "execution.exit.triggered" and .data.triggerType == "TIME_BASED")' \| wc -l` |
| `single_leg_detections` | Single-leg exposure events | Pino structured log | `jq 'select(.msg == "execution.single_leg.exposure")' \| wc -l` |
| `single_leg_resolutions` | Single-leg resolution events | Pino structured log | `jq 'select(.msg == "execution.single_leg.resolved")' \| wc -l` |

### Position Lifecycle Query

Track complete position lifecycles (open -> monitor -> exit):

```sql
SELECT
  id,
  pair_id,
  status,
  created_at AS opened_at,
  updated_at AS last_update,
  EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600 AS lifecycle_hours
FROM open_positions
WHERE created_at >= NOW() - INTERVAL '5 days'
ORDER BY created_at;
```

---

## Risk Metrics

| Column | Description | Source | Collection Method |
|--------|-------------|--------|-------------------|
| `budget_reservations` | Budget reservation events | Pino structured log | `jq 'select(.msg == "risk.budget.reserved")' \| wc -l` |
| `budget_commits` | Budget commit events (execution success) | Pino structured log | `jq 'select(.msg == "risk.budget.committed")' \| wc -l` |
| `budget_releases` | Budget release events (execution failure) | Pino structured log | `jq 'select(.msg == "risk.budget.released")' \| wc -l` |
| `risk_limit_approaches` | Risk limit approach warnings (80% threshold) | Pino structured log | `jq 'select(.msg == "risk.limit.approached")' \| wc -l` |
| `risk_limit_breaches` | Risk limit breaches (trading halt triggered) | Pino structured log | `jq 'select(.msg == "risk.limit.breached")' \| wc -l` |
| `risk_budget_utilization_pct` | Percentage of risk budget in use | `risk_states` table | `SELECT total_capital_deployed FROM risk_states WHERE singleton_key = 'default';` |

> **Note:** `daily_loss_pct` is not meaningful in paper mode — paper fills have no real P&L. Instead, track risk limit enforcement logic (approaches + breaches) to validate the risk pipeline is functioning correctly.

---

## Monitoring Validation Metrics

| Column | Description | Source | Collection Method |
|--------|-------------|--------|-------------------|
| `telegram_alerts_critical` | Critical Telegram alerts sent | `EventConsumerService.getMetrics()` | `jq 'select(.msg == "Telegram alert sent" and .data.severity == "critical")' \| wc -l` |
| `telegram_alerts_warning` | Warning Telegram alerts sent | `EventConsumerService.getMetrics()` | `jq 'select(.msg == "Telegram alert sent" and .data.severity == "warning")' \| wc -l` |
| `telegram_alerts_info` | Info Telegram alerts sent | `EventConsumerService.getMetrics()` | `jq 'select(.msg == "Telegram alert sent" and .data.severity == "info")' \| wc -l` |
| `csv_log_entries` | Rows written to daily CSV trade log | CSV file on VPS | `wc -l /path/to/trades-YYYY-MM-DD.csv` (subtract 1 for header) |
| `daily_summary_generated` | Whether daily summary was produced | Pino structured log / Telegram | Check for `DailySummaryService` log entry or Telegram summary message |
| `audit_chain_valid` | Audit trail hash chain integrity | `AuditLogService.verifyChain()` | Programmatic call (see below) |
| `audit_entries_count` | Total audit log entries | `AuditLogService.verifyChain()` | `entriesChecked` from `ChainVerificationResult` |

### Audit Trail Verification

Run at end of each day and at end of Phase 2:

```typescript
// Via NestJS REPL or future REST endpoint
const result = await auditLogService.verifyChain();
// Returns: { valid: boolean, entriesChecked: number, brokenAtId?: string, brokenAtTimestamp?: Date, expectedHash?: string, actualHash?: string }
```

### CSV Trade Log Known Gaps

Story 6.3 documented 5 columns that show N/A due to event payload gaps. These are **known gaps, NOT validation failures**:
- These columns are expected to show N/A in the CSV output
- The go/no-go criteria explicitly account for this (see P2-3 criterion)
- Only **additional** broken columns beyond these 5 would constitute a failure

### Telegram Severity Reference

For the "at least one of each severity level" criterion, the 36 domain events are classified as:

- **Critical (6):** `execution.single_leg.exposure`, `risk.limit.breached`, `system.trading.halted`, `system.health.critical`, `system.reconciliation.discrepancy`, `time.drift.halt`
- **Warning (6):** `execution.order.failed`, `risk.limit.approached`, `platform.health.degraded`, `time.drift.critical`, `time.drift.warning`, `degradation.protocol.activated`
- **Telegram-eligible Info (6):** `execution.order.filled`, `execution.exit.triggered`, `execution.single_leg.resolved`, `detection.opportunity.identified`, `platform.health.recovered`, `system.trading.resumed`
- **Info (remaining 18):** All other events default to info severity — not sent to Telegram unless in the eligible set above.

> **Manual trigger note:** If some severity levels are never naturally triggered during Phase 2, manually trigger test scenarios (e.g., kill platform connection for critical alert, stop/restart engine for reconciliation events). Document which alerts were manually triggered vs. organically observed.

---

## Resilience Metrics

| Column | Description | Source | Collection Method |
|--------|-------------|--------|-------------------|
| `memory_usage_mb` | Process memory usage (hourly snapshots) | pm2 | `pm2 show pm-arbitrage-engine \| grep memory` |
| `memory_trend` | Increasing / Stable / Decreasing over 24h | Derived from hourly snapshots | Compare first and last hourly readings |
| `connection_recovery_events` | Degradation protocol activation/deactivation pairs | Pino structured log | Count `degradation.protocol.activated` and `degradation.protocol.deactivated` event pairs |
| `graceful_shutdowns` | Intentional shutdown/restart count | pm2 + Pino | `pm2 show pm-arbitrage-engine \| grep "restart time"` |
| `reconciliation_results` | Reconciliation outcome after each restart | Pino structured log | `jq 'select(.msg == "system.reconciliation.complete") \| .data.discrepanciesFound'` |
| `reconciliation_discrepancies` | Unresolved discrepancies after reconciliation | Pino structured log | `jq 'select(.msg == "system.reconciliation.discrepancy")' \| wc -l` |

### Memory Usage Monitoring

Set up hourly memory snapshots via cron:

```bash
# Add to crontab: crontab -e
0 * * * * echo "$(date -Iseconds),$(pm2 show pm-arbitrage-engine --json | jq '.[0].monit.memory')" >> /var/log/pm-arb-memory.csv
```

### Connection Recovery Tracking

```bash
# Count recovery cycles (activation → deactivation pairs)
ACTIVATIONS=$(cat /tmp/day-N-logs.json | jq 'select(.msg == "degradation.protocol.activated")' | wc -l)
DEACTIVATIONS=$(cat /tmp/day-N-logs.json | jq 'select(.msg == "degradation.protocol.deactivated")' | wc -l)
echo "Recovery cycles: activated=${ACTIVATIONS} deactivated=${DEACTIVATIONS}"
```

---

## Daily Recording Table (Phase 2)

Copy this table for each day. Use alongside the [Phase 1 daily table](./phase1-metrics-template.md#daily-recording-table).

### Day N — YYYY-MM-DD

**Execution:**

| Metric | Value |
|--------|-------|
| Paper orders submitted | |
| Paper orders filled | |
| Positions opened | |
| Positions exited | |
| Exit triggers (TP / SL / Time) | / / |
| Single-leg detections | |
| Single-leg resolutions | |
| Complete lifecycles (open→exit) | |

**Risk:**

| Metric | Value |
|--------|-------|
| Budget reservations | |
| Budget commits | |
| Budget releases | |
| Risk limit approaches | |
| Risk limit breaches | |

**Monitoring:**

| Metric | Value |
|--------|-------|
| Telegram alerts (crit / warn / info) | / / |
| CSV log entries | |
| Daily summary generated? | Yes / No |
| Audit chain valid? | Yes / No |
| Audit entries count | |

**Resilience:**

| Metric | Value |
|--------|-------|
| Memory usage (start / end of day) | MB / MB |
| Memory trend | Stable / Increasing / Decreasing |
| Connection recovery events | |
| Restarts today | |
| Reconciliation successful? | Yes / No |
| Unresolved discrepancies | |

---

## Event-to-Metric Mapping (Phase 2 additions)

| Metric Category | Domain Event | Event Name Constant |
|----------------|--------------|---------------------|
| Order filled | `execution.order.filled` | `EVENT_NAMES.ORDER_FILLED` |
| Order failed | `execution.order.failed` | `EVENT_NAMES.EXECUTION_FAILED` |
| Depth check failed | `execution.depth-check.failed` | `EVENT_NAMES.DEPTH_CHECK_FAILED` |
| Single-leg exposure | `execution.single_leg.exposure` | `EVENT_NAMES.SINGLE_LEG_EXPOSURE` |
| Single-leg resolved | `execution.single_leg.resolved` | `EVENT_NAMES.SINGLE_LEG_RESOLVED` |
| Exit triggered | `execution.exit.triggered` | `EVENT_NAMES.EXIT_TRIGGERED` |
| Risk limit approached | `risk.limit.approached` | `EVENT_NAMES.LIMIT_APPROACHED` |
| Risk limit breached | `risk.limit.breached` | `EVENT_NAMES.LIMIT_BREACHED` |
| Budget reserved | `risk.budget.reserved` | `EVENT_NAMES.BUDGET_RESERVED` |
| Budget committed | `risk.budget.committed` | `EVENT_NAMES.BUDGET_COMMITTED` |
| Budget released | `risk.budget.released` | `EVENT_NAMES.BUDGET_RELEASED` |
| Compliance blocked | `execution.compliance.blocked` | `EVENT_NAMES.COMPLIANCE_BLOCKED` |
| Reconciliation complete | `system.reconciliation.complete` | `EVENT_NAMES.RECONCILIATION_COMPLETE` |
| Reconciliation discrepancy | `system.reconciliation.discrepancy` | `EVENT_NAMES.RECONCILIATION_DISCREPANCY` |
| Audit log failed | `monitoring.audit.write_failed` | `EVENT_NAMES.AUDIT_LOG_FAILED` |
| Audit chain broken | `monitoring.audit.chain_broken` | `EVENT_NAMES.AUDIT_CHAIN_BROKEN` |

---

## Notes

- All Phase 1 metrics continue to be collected during Phase 2.
- Paper trading uses `PaperTradingConnector` wrapping real connectors — real market data, simulated execution.
- `daily_loss_pct` is not tracked in paper mode; instead validate that risk limit enforcement logic fires correctly.
- CSV trade log path is configurable via `TRADE_LOG_DIR` environment variable.
- `monitoring.audit.chain_broken` and `platform.health.disconnected` currently default to Info severity — consider escalating to Critical/Warning respectively as a post-validation improvement.
