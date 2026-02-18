# Technical Debt Registry

Consolidated from Epics 1–4 story dev notes, retrospectives, and codebase scans.

Last updated: 2026-02-18 (Story 4.5.4)

## Debt Items

| # | Description | Priority | Target Epic | Source |
|---|-------------|----------|-------------|--------|
| 1 | **Kalshi order book normalization duplicated in 3 locations** — `connectors/kalshi/kalshi.connector.ts` (lines 148–155), `connectors/kalshi/kalshi-websocket.client.ts` (lines 287–295), and `modules/data-ingestion/order-book-normalizer.service.ts` (lines 28–35) all repeat the cents-to-decimal + NO-to-YES inversion transformation. Extract to a shared utility in `common/utils/`. | High | ~~Epic 5~~ **Story 4.5.5** | Codebase scan (Stories 1-4, 2-2) |
| 2 | **TODO: Story 5.1 — replace with `IExecutionEngine.execute()` call** — Placeholder in `modules/execution/execution-queue.service.ts` line 53. The execution queue dequeues opportunities but does not yet invoke the real execution engine. | Medium | Epic 5 (Story 5.1) | `execution-queue.service.ts:53` |
| 3 | **TODO(Epic 5): Add gas estimation for on-chain settlement** — Placeholder in `connectors/polymarket/polymarket.connector.ts` line 312. Gas costs are not yet factored into Polymarket execution cost calculations. | Medium | Epic 5 | `polymarket.connector.ts:312` |
| 4 | **Error code numbering deviates from PRD** — PRD specifies `3001 = Daily Loss Limit Exceeded`; implementation uses `3001 = Position Size Exceeded`, `3003 = Daily Loss Limit Breached`. Shipped with 397+ tests validating current codes. Follow implementation numbering going forward; do not renumber. | Low | Post-Epic 5 reconciliation | Story 4-2 Dev Notes |
| 5 | **Polymarket order book transformation minor duplication** — `connectors/polymarket/polymarket-websocket.client.ts` and `connectors/polymarket/polymarket.connector.ts` both contain order book transformation logic. Less critical than Kalshi (no cents conversion or YES/NO inversion). | Low | Monitor | Codebase scan |
| 6 | **`forwardRef()` used for ConnectorModule ↔ DataIngestionModule circular dependency** — Functional but is a code smell. Consider restructuring module boundaries if the dependency graph grows more complex. | Low | Monitor | Story 2-2 Dev Notes |
