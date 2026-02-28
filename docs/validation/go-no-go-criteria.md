# Go/No-Go Criteria — Paper Trading Validation Gates

**Created:** 2026-02-28
**Approval Status:** APPROVED
**Approved By:** Arbi
**Approval Date:** 2026-02-28

**Related:** [Phase 1 Metrics](./phase1-metrics-template.md) | [Phase 2 Metrics](./phase2-metrics-template.md) | [Observation Log](./observation-log-template.md)

---

## Overview

This document defines explicit pass/fail criteria for two validation gates:

1. **Phase 1 → Phase 2 Gate** — After 48h of read-only detection, decide whether to proceed to paper execution.
2. **Phase 2 → Epic 7 Gate** — After 5 days of paper execution, decide whether to proceed to the operator dashboard and advanced features.

Each criterion has three outcomes:
- **Pass** — Criterion met, proceed.
- **Fail** — Criterion not met, stop and investigate.
- **Conditional Proceed** — Criterion partially met, proceed with documented risk and/or remediation plan.

---

## Phase 1 → Phase 2 Gate

**Phase 1 duration:** 48 hours minimum (read-only detection, no execution)
**Decision point:** End of 48h observation period

| # | Criterion | Pass | Fail | Conditional Proceed |
|---|-----------|------|------|---------------------|
| P1-1 | Opportunity detection frequency | >=2 opportunities detected over 48h (validates >=8/week PRD pace) | 0 opportunities in 48h (detection fundamentally broken) | 1 opportunity: investigate edge thresholds, market activity, pair coverage. Document findings. If root cause is market conditions (not code), adjust thresholds and proceed. Note: 48h is a limited sample — low count may reflect market inactivity, not system failure. |
| P1-2 | Detection latency | p95 < 1s (per NFR-P2: detection cycle < 1 second) | p95 > 5s (unusable for execution) | 1s < p95 < 5s: document bottleneck, assess whether it impacts Phase 2 execution timing. Proceed if execution latency budget is not consumed. |
| P1-3 | System stability | Zero unhandled crashes/exceptions in 48h | >3 unhandled crashes OR any crash requiring manual data repair | 1-3 crashes: root cause each, determine if intermittent (network) or systematic (code bug). Fix and extend Phase 1 by 24h for re-validation. |
| P1-4 | Platform connectivity | Both platforms >95% uptime over 48h | Either platform <80% uptime | 80-95% uptime: investigate root cause (rate limits? API changes? VPS network?). If external to our system and recoverable, proceed with documented risk. |
| P1-5 | Data integrity | <0.1% of order book snapshots have integrity issues (NaN/null in financial fields) — allows for rare transient API errors | >5% of snapshots have data integrity issues | 0.1-5%: investigate pattern, determine if platform-side or our normalization. Fix if ours, document if theirs. |
| P1-6 | Contract matching accuracy | Zero contract matching errors across all detected opportunities (PRD absolute threshold) | Any systematic mismatch between configured pairs and platform contracts | N/A — contract matching accuracy is binary pass/fail per PRD. Any error halts trading. |

### How to Evaluate Phase 1 Criteria

**P1-1: Opportunity detection frequency**
```bash
# Count opportunities over the 48h period
cat /tmp/phase1-logs.json | jq 'select(.msg == "detection.opportunity.identified")' | wc -l
```

**P1-2: Detection latency**
```bash
# Extract latencies and compute p95
cat /tmp/phase1-logs.json | jq -r 'select(.msg == "Detection cycle complete") | .data.durationMs' | sort -n > /tmp/latencies.txt
TOTAL=$(wc -l < /tmp/latencies.txt)
P95=$(sed -n "$((TOTAL * 95 / 100))p" /tmp/latencies.txt)
echo "p95 = ${P95}ms"
```

**P1-3: System stability**
```bash
# Check pm2 restart count
pm2 show pm-arbitrage-engine | grep "restart time"

# Scan for unhandled exceptions
cat /tmp/phase1-logs.json | jq 'select(.level >= 50 and (.msg | test("unhandled|uncaught|fatal"; "i")))' | wc -l
```

**P1-4: Platform connectivity**
```sql
-- Platform uptime over 48h (see phase1-metrics-template.md for full query)
SELECT platform,
  ROUND(100.0 * SUM(
    CASE WHEN status = 'healthy'
      THEN EXTRACT(EPOCH FROM (
        COALESCE(LEAD(created_at) OVER (PARTITION BY platform ORDER BY created_at), NOW()) - created_at
      )) ELSE 0 END
  ) / EXTRACT(EPOCH FROM INTERVAL '48 hours'), 1) AS uptime_pct
FROM platform_health_logs
WHERE created_at >= NOW() - INTERVAL '48 hours'
GROUP BY platform;
```

**P1-5: Data integrity**
```bash
# Check for NaN/null in financial fields of order book snapshots
cat /tmp/phase1-logs.json | jq 'select(.msg == "orderbook.updated") | select(.data.bids == null or .data.asks == null or (.data | tostring | test("NaN|null|undefined")))' | wc -l

# Total snapshots
cat /tmp/phase1-logs.json | jq 'select(.msg == "orderbook.updated")' | wc -l

# Calculate percentage
echo "scale=4; (ISSUES / TOTAL) * 100" | bc
```

**P1-6: Contract matching accuracy**
```bash
# Any contract matching errors would appear as error-level logs from contract-matching module
cat /tmp/phase1-logs.json | jq 'select(.module == "contract-matching" and .level >= 50)' | wc -l
# Must be 0
```

---

## Phase 2 → Epic 7 Gate

**Phase 2 duration:** 5 days minimum (paper execution mode)
**Decision point:** End of 5-day observation period

| # | Criterion | Pass | Fail | Conditional Proceed |
|---|-----------|------|------|---------------------|
| P2-1 | System stability | Zero unhandled crashes in 5-day run | >3 crashes OR any data corruption | 1-3 crashes: same protocol as P1-3, extend Phase 2 by 48h after fixes |
| P2-2 | Telegram alerts functional | At least one alert of each severity level (critical, warning, info) observed or manually triggered during 5 days | Telegram integration completely non-functional (zero alerts sent) | Some severity levels never triggered: manually trigger remaining levels via test scenarios (e.g., kill platform connection for critical alert). Document results. |
| P2-3 | CSV trade logging | Daily CSV files populated with correct columns. Missing fields limited to 5 documented N/A columns from Story 6.3 | CSV files empty, missing, or with >5 additional broken columns | Minor formatting issues: fix and document. N/A columns from Story 6.3 are known gaps, NOT failures. |
| P2-4 | Daily summaries | `DailySummaryService` produces summary for each day of Phase 2 | Zero summaries generated | Partial summaries: investigate cron timing, fix and extend. |
| P2-5 | Audit trail integrity | `verifyChain()` returns `valid: true` at end of Phase 2 | `valid: false` — hash chain broken | N/A — chain integrity is binary pass/fail. If broken, investigate `brokenAtId` and `brokenAtTimestamp` in `ChainVerificationResult`. |
| P2-6 | Reconciliation | At least one intentional restart with successful reconciliation (zero unresolved discrepancies) | Reconciliation fails OR leaves unresolved discrepancies after restart | Minor discrepancies resolved by reconciliation engine: pass (that's its job). Only fail if discrepancies remain unresolved. |
| P2-7 | Single-leg exposure | <3 events requiring manual operator intervention over 5 days (PRD success gate). **Definition of "manual intervention"**: events where the single-leg resolution service cannot auto-resolve and the operator must manually retry or close via API. Auto-resolved single-leg events do NOT count toward this threshold. | >=5 events requiring manual intervention | 3-4 events: evaluate root cause distribution. If all from same pair/platform, may be pair-specific — remove pair and document. If systemic, fail. |
| P2-8 | Paper execution coverage | At least 3 complete position lifecycles (open -> monitor -> exit) observed | Zero complete lifecycles | 1-2 lifecycles: extend Phase 2 by 48h. If still insufficient, evaluate whether market conditions or system config are limiting factor. |

### How to Evaluate Phase 2 Criteria

**P2-1: System stability**
```bash
# Same as P1-3 but over 5-day window
pm2 show pm-arbitrage-engine | grep "restart time"
cat /tmp/phase2-logs.json | jq 'select(.level >= 50 and (.msg | test("unhandled|uncaught|fatal"; "i")))' | wc -l
```

**P2-2: Telegram alerts functional**
```bash
# Count alerts by severity
cat /tmp/phase2-logs.json | jq -r 'select(.msg == "Telegram alert sent") | .data.severity' | sort | uniq -c

# Expected output should show at least 1 of each: critical, warning, info
# If any severity is missing, manually trigger:
#   Critical: kill platform connection or simulate time drift halt
#   Warning: trigger rate limit approach or platform degradation
#   Info: opportunities detected and orders filled happen naturally in paper mode
```

**P2-3: CSV trade logging**
```bash
# Check CSV files exist and have content
ls -la ${TRADE_LOG_DIR}/trades-*.csv
for f in ${TRADE_LOG_DIR}/trades-*.csv; do
  echo "$(basename $f): $(wc -l < $f) rows"
done

# Verify column count (subtract 1 for known N/A columns from Story 6.3)
head -1 ${TRADE_LOG_DIR}/trades-*.csv | awk -F',' '{print NF " columns"}'
```

**P2-4: Daily summaries**
```bash
# Check for daily summary generation
cat /tmp/phase2-logs.json | jq 'select(.msg | test("daily.summary|DailySummary"; "i"))' | wc -l

# Or verify Telegram received daily summary messages (check Telegram chat history)
```

**P2-5: Audit trail integrity**
```typescript
// Run via NestJS REPL or programmatic call
const result = await auditLogService.verifyChain();
console.log(`Valid: ${result.valid}, Entries checked: ${result.entriesChecked}`);
if (!result.valid) {
  console.log(`Broken at: ${result.brokenAtId} (${result.brokenAtTimestamp})`);
  console.log(`Expected: ${result.expectedHash}, Actual: ${result.actualHash}`);
}
```

**P2-6: Reconciliation**
```bash
# Intentionally restart the engine
pm2 restart pm-arbitrage-engine

# Wait for startup, then check reconciliation result
cat /tmp/phase2-logs.json | jq 'select(.msg == "system.reconciliation.complete") | .data'
# discrepanciesFound should be 0 (or all auto-resolved)
```

**P2-7: Single-leg exposure**
```bash
# Count single-leg exposure events
cat /tmp/phase2-logs.json | jq 'select(.msg == "execution.single_leg.exposure")' | wc -l

# Count auto-resolved (these do NOT count toward the threshold)
cat /tmp/phase2-logs.json | jq 'select(.msg == "execution.single_leg.resolved")' | wc -l

# Manual interventions = exposures - auto-resolutions
# Must be <3
```

**P2-8: Paper execution coverage**
```sql
-- Count complete position lifecycles (opened and subsequently closed)
SELECT COUNT(*) AS complete_lifecycles
FROM open_positions
WHERE status = 'CLOSED'
  AND created_at >= NOW() - INTERVAL '5 days';
-- Must be >= 3
```

---

## Appendix A: Existing System Infrastructure

Maps each metric category to its data source for collection.

| Data Source | What It Provides | Access Method |
|-------------|-----------------|---------------|
| Structured JSON logs (pm2) | Per-cycle detection latency, opportunities, edges, platform status, all event emissions | `pm2 logs pm-arbitrage-engine --nostream --lines N --json \| jq '...'` |
| `platform_health_logs` table | Platform health transitions with timestamps (transition-only persistence per Story 6.5.2a) | SQL via Prisma Studio or `psql` via SSH tunnel |
| `orders` table | Paper orders submitted, fill statuses, timestamps | SQL query |
| `open_positions` table | Position lifecycle: status, entry prices, exit triggers | SQL query |
| `risk_states` table | Risk budget state: daily P&L, capital deployed, halt status | SQL query (singleton row, `singleton_key = 'default'`) |
| `EventConsumerService.getMetrics()` | In-memory event counters: `totalEventsProcessed`, per-event `eventCounts`, `severityCounts` (critical/warning/info), `errorsCount`, `lastEventTimestamp` | Log dump at end of phase or future REST endpoint |
| `AuditLogService.verifyChain()` | Hash chain integrity: `valid`, `entriesChecked`, `brokenAtId`, `brokenAtTimestamp`, `expectedHash`, `actualHash` | Programmatic call via NestJS REPL |
| CSV trade log files | Per-trade records with timestamps (5 known N/A columns from Story 6.3) | `wc -l`, `cat`, `head` on VPS (path: `TRADE_LOG_DIR` env var) |
| `DailySummaryService` | Daily aggregates: `totalTrades`, `totalPnl`, `opportunitiesDetected`, `opportunitiesExecuted`, `openPositions`, `closedPositions`, `singleLegEvents`, `riskLimitEvents`, `systemHealthSummary` | Telegram message + structured log |
| pm2 process metrics | Memory usage, CPU %, restart count, uptime | `pm2 monit`, `pm2 show pm-arbitrage-engine` |
| `StartupReconciliationService.reconcile()` | Post-restart consistency: checks pending orders and active positions against platform state | Emits `system.reconciliation.complete` event with `discrepanciesFound` count |

---

## Appendix B: Domain Event Severity Classification

Reference for the Telegram alerting criterion (P2-2). The 36 domain events in `EventConsumerService` are classified as follows:

### Critical Events (6) — `CRITICAL_EVENTS` constant

Always trigger high-priority Telegram alert.

| Event | Name | Typical Trigger |
|-------|------|-----------------|
| `execution.single_leg.exposure` | Single-leg exposure detected | Only one leg of a two-leg trade filled |
| `risk.limit.breached` | Risk limit breached | Position/loss limit exceeded, trading halted |
| `system.trading.halted` | Trading halted | Any halt reason (risk, time drift, reconciliation) |
| `system.health.critical` | Critical system health | Database failure, unrecoverable state |
| `system.reconciliation.discrepancy` | Reconciliation discrepancy | Post-restart position/order mismatch |
| `time.drift.halt` | Time drift halt | Clock drift >1000ms, trading halted |

### Warning Events (6) — `WARNING_EVENTS` constant

Always trigger Telegram alert at warning level.

| Event | Name | Typical Trigger |
|-------|------|-----------------|
| `execution.order.failed` | Order execution failed | Platform rejected order or timeout |
| `risk.limit.approached` | Risk limit approaching | 80% of position/loss threshold |
| `platform.health.degraded` | Platform health degraded | High latency, partial failures |
| `time.drift.critical` | Time drift critical | Clock drift 500-1000ms |
| `time.drift.warning` | Time drift warning | Clock drift 100-500ms |
| `degradation.protocol.activated` | Degradation protocol activated | Platform degraded for >81s |

### Telegram-Eligible Info Events (6) — `TELEGRAM_ELIGIBLE_INFO_EVENTS` constant

Trigger Telegram alert at info level (operationally important info).

| Event | Name | Typical Trigger |
|-------|------|-----------------|
| `execution.order.filled` | Order filled | Successful order fill on platform |
| `execution.exit.triggered` | Exit triggered | Take-profit, stop-loss, or time-based exit |
| `execution.single_leg.resolved` | Single-leg resolved | Exposed leg retried or closed |
| `detection.opportunity.identified` | Opportunity identified | Arbitrage edge above threshold detected |
| `platform.health.recovered` | Platform recovered | Platform returned to healthy state |
| `system.trading.resumed` | Trading resumed | Halt reason cleared, trading active |

### Info Events (remaining 18) — Default severity

Logged but NOT sent to Telegram (unless added to the eligible set above).

| Event | Name |
|-------|------|
| `platform.health.updated` | Periodic health status update |
| `platform.health.disconnected` | Platform fully disconnected |
| `platform.health.data-stale` | WebSocket data staleness (>30s) |
| `orderbook.updated` | Order book normalized and persisted |
| `degradation.protocol.deactivated` | Degradation protocol deactivated |
| `detection.opportunity.filtered` | Opportunity filtered (below threshold) |
| `execution.depth-check.failed` | Depth verification API error |
| `execution.single_leg.exposure_reminder` | Periodic re-emit for unresolved exposure |
| `risk.override.applied` | Operator override approved |
| `risk.override.denied` | Operator override denied |
| `risk.budget.reserved` | Budget reserved for opportunity |
| `risk.budget.committed` | Budget committed after execution |
| `risk.budget.released` | Budget released after failure |
| `system.reconciliation.complete` | Reconciliation finished |
| `platform.gas.updated` | Gas estimate changed significantly |
| `execution.compliance.blocked` | Trade blocked by compliance check |
| `monitoring.audit.write_failed` | Audit log write failure |
| `monitoring.audit.chain_broken` | Hash chain integrity broken |

> **Potential improvements (post-validation):**
> - `monitoring.audit.chain_broken` currently defaults to Info — consider escalating to **Critical** (broken audit chain is a compliance issue).
> - `platform.health.disconnected` currently defaults to Info — consider escalating to **Warning** (full disconnect is more severe than degraded).

---

## Appendix C: PRD-Sourced Thresholds

Reference for where each threshold originates.

| Threshold | PRD Source | Application |
|-----------|-----------|-------------|
| >=8 opportunities/week | `prd.md` lines 332-345 (MVP Success Gate: 50+ completed arbitrage cycles) | P1-1: detection frequency |
| Detection cycle <1s | `prd.md` NFR-P2 | P1-2: detection latency |
| Zero contract matching errors | `prd.md` lines 332-345 (absolute threshold) | P1-6: contract matching |
| <3 single-leg events requiring manual intervention | `prd.md` lines 332-345 (MVP Success Gate) | P2-7: single-leg exposure |
| Order book normalization <500ms | `prd.md` NFR-P1 | Informational (ingestion latency ~150ms after 6.5.2a) |
| Execution submission <100ms between legs | `prd.md` NFR-P3 | Applicable to Phase 2 paper execution |
