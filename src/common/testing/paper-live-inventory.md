# Paper/Live Mode Boundary Inventory

Story 10-5.5 — Created 2026-03-23

## Summary

The codebase has **24 paper/live boundary points** across **9 architectural layers**.

- **(a) Has dual-mode test coverage:** 18 boundary points
- **(b) Needs test coverage:** 6 gaps (addressed by `paper-live-boundary/` test suite)
- **(c) Structurally cannot contaminate:** Event types, Telegram formatter, CSV trade log

## Inventory

### Layer 1: Connector Module (DI-based mode selection)

| # | Location | File | Divergence | Category |
|---|----------|------|-----------|----------|
| 1 | `ConnectorModule.validatePlatformMode()` | `src/connectors/connector.module.ts` | Paper: wraps real connector in `PaperTradingConnector`. Live: uses real connector directly | (a) 6 unit tests |
| 2 | `PaperTradingConnector` (full class) | `src/connectors/paper/paper-trading.connector.ts` | Delegates data methods to real connector; intercepts execution with `FillSimulatorService` | (a) unit tests exist |
| 3 | `FillSimulatorService.simulateFill()` | `src/connectors/paper/fill-simulator.service.ts` | All paper fills return `status: 'filled'` immediately; live fills depend on platform | **(b)** `connectors.spec.ts` |

### Layer 2: Core Engine

| # | Location | File | Divergence | Category |
|---|----------|------|-----------|----------|
| 4 | `EngineLifecycleService.validatePlatformModes()` | `src/core/engine-lifecycle.service.ts` | Mixed mode validation; only live positions trigger reconciliation halt (`is_paper = false`) | (a) 3 tests |
| 5 | `TradingEngine` isPaper determination | `src/core/trading-engine.service.ts` | `isPaper = kalshiHealth.mode === 'paper' \|\| polymarketHealth.mode === 'paper'`; passed to riskManager + reservations | (a) 3 tests |

### Layer 3: Risk Management (dual state machines)

| # | Location | File | Divergence | Category |
|---|----------|------|-----------|----------|
| 6 | `getState(isPaper)` / `getBankrollForMode(isPaper)` | `src/modules/risk-management/risk-manager.service.ts` | Routes to `paperState` or `liveState`; paper uses `paperBankrollUsd` fallback | (a) unit tests |
| 7 | `reserveBudget(request)` | `src/modules/risk-management/risk-manager.service.ts` | Paper: dedup via `paperActivePairIds`; paper: skips live halt check | (a) 10+ tests |
| 8 | `updateDailyPnl(delta, isPaper)` | `src/modules/risk-management/risk-manager.service.ts` | Paper: adds halt to `paperState.activeHaltReasons` only. Live: calls `haltTrading()` affecting `liveState` | (a) unit tests |
| 9 | `haltTrading(reason)` / `resumeTrading(reason)` | `src/modules/risk-management/risk-manager.service.ts` | **LIVE-ONLY** — always operates on `liveState.activeHaltReasons` | **(b)** `risk.spec.ts` |
| 10 | `closePosition(capital, pnl, pairId, isPaper)` | `src/modules/risk-management/risk-manager.service.ts` | Removes from `paperActivePairIds` if paper; updates mode-specific state | (a) tested |
| 11 | `dailyReset()` | `src/modules/risk-management/risk-manager.service.ts` | Resets BOTH modes independently | (a) tested |

### Layer 4: Execution Module (flag propagation)

| # | Location | File | Divergence | Category |
|---|----------|------|-----------|----------|
| 12 | `ExecutionService` isPaper/mixedMode | `src/modules/execution/execution.service.ts` | Pure propagation to order records, position records, events | (a) 7 tests |
| 13 | `AutoUnwindService` | `src/modules/execution/auto-unwind.service.ts` | `simulated = event.isPaper` for `AutoUnwindEvent` | (a) 4 P0 tests |

### Layer 5: Exit Management (mode-filtered queries)

| # | Location | File | Divergence | Category |
|---|----------|------|-----------|----------|
| 14 | `ExitMonitor.evaluatePositions()` | `src/modules/exit-management/exit-monitor.service.ts` | Position query filtered by `isPaper` (paper evaluates paper only); mode-specific risk calls | **(b)** `exit.spec.ts` |

### Layer 6: Monitoring (Telegram dedup)

| # | Location | File | Divergence | Category |
|---|----------|------|-----------|----------|
| 15 | `EventConsumerService` paper dedup | `src/modules/monitoring/event-consumer.service.ts` | `isPaperMode` computed from config at construction; suppresses duplicate opportunity Telegram alerts | **(b)** `monitoring.spec.ts` |

### Layer 7: Dashboard (mode filtering)

| # | Location | File | Divergence | Category |
|---|----------|------|-----------|----------|
| 16 | `DashboardService.getPositions()` / `getOverview()` | `src/dashboard/dashboard.service.ts` | Mode query param -> isPaper filter; separate live/paper capital overview | **(b)** `dashboard.spec.ts` |

### Layer 8: Persistence (repository mode-scoping)

| # | Location | File | Divergence | Category |
|---|----------|------|-----------|----------|
| 17 | `PositionRepository` 5 query methods | `src/persistence/repositories/position.repository.ts` | `isPaper` parameter — required (no default) with `withModeFilter` convention | (a) 8 tests |
| 18 | `OrderRepository` 2 query methods | `src/persistence/repositories/order.repository.ts` | `isPaper` parameter — required (no default) with `withModeFilter` convention | (a) 2 tests |
| 21 | `PositionRepository.countByStatus()` | `src/persistence/repositories/position.repository.ts` | `isPaper` parameter — required (no default) with `withModeFilter` convention | (a) compiler-enforced |
| 22 | `PositionRepository.countClosedByDateRange()` | `src/persistence/repositories/position.repository.ts` | `isPaper` parameter — required (no default) with `withModeFilter` convention | (a) compiler-enforced |
| 23 | `PositionRepository.sumClosedEdgeByDateRange()` | `src/persistence/repositories/position.repository.ts` | `isPaper` parameter — required (no default) with `withModeFilter` convention | (a) compiler-enforced |
| 24 | `OrderRepository.countByDateRange()` | `src/persistence/repositories/order.repository.ts` | `isPaper` parameter — required (no default) with `withModeFilter` convention | (a) compiler-enforced |

### Layer 9: Reconciliation (dual-mode recalculation)

| # | Location | File | Divergence | Category |
|---|----------|------|-----------|----------|
| 19 | `recalculateRiskBudget()` | `src/reconciliation/startup-reconciliation.service.ts` | Iterates `[false, true]` for isPaper independently | (a) tested |
| 20 | `reconciliation.controller.ts` status endpoint | `src/reconciliation/reconciliation.controller.ts` | Hardcodes `isPaper=false` — only live positions need reconciliation | **(b)** `reconciliation.spec.ts` |

## Raw SQL Audit

| # | File | Line | Query | Mode-Filtered |
|---|------|------|-------|---------------|
| 1 | `src/app.service.ts` | 18 | `SELECT 1` (health check) | N/A — no mode-sensitive table |
| 2 | `src/core/engine-lifecycle.service.ts` | 56 | `SELECT 1` (health check) | N/A — no mode-sensitive table |
| 3 | `src/core/engine-lifecycle.service.ts` | 150 | `SELECT COUNT(*) FROM open_positions WHERE ... AND is_paper = false` | YES — `-- MODE-FILTERED` marker added |

No other `$queryRaw`, `$executeRaw`, or `$queryRawUnsafe` calls found. Migration files and seed scripts are excluded (schema operations, not runtime data).

## Structurally Safe (Category C)

- **Event types** (`common/events/execution.events.ts`): carry `isPaper` as data field only — no branching
- **Telegram formatter**: display-only `[PAPER]`/`[MIXED]` tags — no state mutation
- **CSV trade log**: recording-only — no state mutation
