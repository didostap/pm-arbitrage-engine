/**
 * Story 10-5.5 — Paper/Live Mode Boundary Test Suite
 *
 * Per-module integration tests verifying paper/live mode isolation.
 * Covers all 8 coverage gaps identified in the boundary inventory.
 *
 * Test files:
 * - risk.spec.ts          — RiskManager state isolation (7 P0 tests)
 * - connectors.spec.ts    — FillSimulator + PaperTradingConnector (3 P0 tests)
 * - exit.spec.ts          — ExitMonitor mode filtering (3 P0 + 1 P1 tests)
 * - execution.spec.ts     — ExecutionService flag propagation (3 P1 tests)
 * - reconciliation.spec.ts — Dual-mode recalculation (2 P1 tests)
 * - dashboard.spec.ts     — Mode-filtered queries (3 P1 tests)
 * - monitoring.spec.ts    — Telegram dedup isolation (2 P1 tests)
 * - mode-filter.helper.spec.ts — withModeFilter() helper (3 P0 tests)
 */

// This barrel exists for documentation and module discovery.
// Test files are auto-discovered by Vitest via **/*.spec.ts glob.
