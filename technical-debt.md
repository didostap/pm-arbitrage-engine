# Technical Debt Registry

Consolidated from Epics 1–4 story dev notes, retrospectives, and codebase scans.

Last updated: 2026-02-22 (Story 5.5.0)

## Debt Items

| # | Description | Priority | Target Epic | Source |
|---|-------------|----------|-------------|--------|
| 1 | ~~**Kalshi order book normalization duplicated in 3 locations**~~ **RESOLVED (Story 4.5.5)** — Extracted `normalizeKalshiLevels` utility. | ~~High~~ | ~~Story 4.5.5~~ | Codebase scan (Stories 1-4, 2-2) |
| 2 | ~~**TODO: Story 5.1 — replace with `IExecutionEngine.execute()` call**~~ **RESOLVED (Story 5.1)** — `IExecutionEngine.execute()` call implemented. | ~~Medium~~ | ~~Epic 5 (Story 5.1)~~ | `execution-queue.service.ts:53` |
| 3 | **TODO(Epic 6, Story 6.0): Add gas estimation for on-chain settlement** — Placeholder in `connectors/polymarket/polymarket.connector.ts` line 312. Gas costs are not yet factored into Polymarket execution cost calculations. | Medium | Epic 6 (Story 6.0) | `polymarket.connector.ts:312` |
| 4 | **Error code numbering deviates from PRD** — PRD specifies `3001 = Daily Loss Limit Exceeded`; implementation uses `3001 = Position Size Exceeded`, `3003 = Daily Loss Limit Breached`. Shipped with 397+ tests validating current codes. Follow implementation numbering going forward; do not renumber. | Low | Post-Epic 5 reconciliation | Story 4-2 Dev Notes |
| 5 | **Polymarket order book transformation minor duplication** — `connectors/polymarket/polymarket-websocket.client.ts` and `connectors/polymarket/polymarket.connector.ts` both contain order book transformation logic. Less critical than Kalshi (no cents conversion or YES/NO inversion). | Low | Monitor | Codebase scan |
| 6 | **`forwardRef()` used for ConnectorModule ↔ DataIngestionModule circular dependency** — Functional but is a code smell. Consider restructuring module boundaries if the dependency graph grows more complex. | Low | Monitor | Story 2-2 Dev Notes |
| 7 | ~~**`cancelOrder()` placeholder on both connectors**~~ **RESOLVED (Story 5.5.0)** — Real `cancelOrder()` implemented on both Kalshi and Polymarket connectors with full error handling and tests. | ~~Medium~~ | ~~Story 5.5.0~~ | Story 5.5.0 |
| 8 | **`getPositions()` still unimplemented on both connectors** — Returns placeholder/throws on Kalshi and Polymarket connectors. Not needed until portfolio-level reconciliation is implemented. | Low | Future (portfolio reconciliation) | Story 5.5.0 |
| 9 | **Reconciliation module at `src/reconciliation/` instead of `persistence/`** — Per architecture spec, reconciliation should live under `persistence/`. Current placement at `src/reconciliation/` is an intentional deviation; ADR documented. | Low | Monitor (ADR documented) | Story 5.5.0 |
| 10 | ~~**Persistence repository coverage gap: 52.17% statements / 0% branches**~~ **AUDITED (Story 5.5.0 Task 7)** — Coverage audit completed. Most untested methods are Prisma pass-throughs (low risk). Business logic gaps identified and tracked as items #11 and #12. See `docs/coverage-audit.md`. | ~~Medium~~ | ~~Story 5.5.0 Task 7~~ | Story 5.5.0 |
| 11 | **`OrderRepository.updateOrderStatus()` has 0% branch coverage** — Conditional `fillPrice`/`fillSize` inclusion logic (lines 45-48) is untested. Four test cases needed to cover all branch combinations. | Medium | Next stabilization sprint | Coverage audit (Story 5.5.0 Task 7) |
| 12 | **`PositionRepository.findActivePositions()` hardcoded status list unguarded** — The status list (`OPEN`, `SINGLE_LEG_EXPOSED`, `EXIT_PARTIAL`, `RECONCILIATION_REQUIRED`) encodes domain logic about "active" positions. No test asserts this list, risking silent omission when new statuses are added. | Low | Future (when position lifecycle evolves) | Coverage audit (Story 5.5.0 Task 7) |
