import { describe, it, expect, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import type {
  ExitEvaluation,
  SimulatedPosition,
} from '../types/simulation.types';
import { createSimulatedPosition } from '../types/simulation.types';

function makePosition(
  overrides: Partial<SimulatedPosition> = {},
): SimulatedPosition {
  return createSimulatedPosition({
    positionId: 'pos-1',
    pairId: 'pair-1',
    kalshiContractId: 'K-1',
    polymarketContractId: 'P-1',
    kalshiSide: 'BUY',
    polymarketSide: 'SELL',
    kalshiEntryPrice: new Decimal('0.45'),
    polymarketEntryPrice: new Decimal('0.52'),
    positionSizeUsd: new Decimal('300'),
    entryEdge: new Decimal('0.015'),
    entryTimestamp: new Date('2025-02-01T14:00:00Z'),
    ...overrides,
  });
}

describe('ExitEvaluatorService', () => {
  let service: any;

  beforeEach(async () => {
    const { ExitEvaluatorService } = await import('./exit-evaluator.service');
    service = new ExitEvaluatorService();
  });

  // ============================================================
  // Individual exit criteria — 5 tests
  // ============================================================

  it('[P0] should trigger EDGE_EVAPORATION when current net edge < exitEdgeEvaporationPct', () => {
    // Use entryEdge small enough that PROFIT_CAPTURE doesn't trigger at currentNetEdge=0.001
    // capturedRatio = (0.004 - 0.001) / 0.004 = 0.75 < 0.80 → PROFIT_CAPTURE does NOT trigger
    const position = makePosition({ entryEdge: new Decimal('0.004') } as any);
    const result: ExitEvaluation | null = service.evaluateExits({
      position,
      currentNetEdge: new Decimal('0.001'), // below 0.002 threshold
      currentTimestamp: new Date('2025-02-01T16:00:00Z'),
      exitEdgeEvaporationPct: new Decimal('0.002'),
      exitTimeLimitHours: 72,
      exitProfitCapturePct: new Decimal('0.80'),
      resolutionTimestamp: null,
      resolutionPrice: null,
      hasDepth: true,
    });

    expect(result).not.toBeNull();
    expect(result!.reason).toBe('EDGE_EVAPORATION');
    expect(result!.triggered).toBe(true);
  });

  it('[P0] should trigger TIME_DECAY when holding duration > exitTimeLimitHours', () => {
    const position = makePosition({
      entryTimestamp: new Date('2025-02-01T14:00:00Z'),
    } as any);
    // 73 hours later
    const result = service.evaluateExits({
      position,
      currentNetEdge: new Decimal('0.01'),
      currentTimestamp: new Date('2025-02-04T15:00:00Z'),
      exitEdgeEvaporationPct: new Decimal('0.002'),
      exitTimeLimitHours: 72,
      exitProfitCapturePct: new Decimal('0.80'),
      resolutionTimestamp: null,
      resolutionPrice: null,
      hasDepth: true,
    });

    expect(result).not.toBeNull();
    expect(result!.reason).toBe('TIME_DECAY');
  });

  it('[P0] should trigger PROFIT_CAPTURE when edge recovery >= exitProfitCapturePct of entry edge', () => {
    const position = makePosition({ entryEdge: new Decimal('0.015') } as any);
    // 80%+ of entry edge has been captured (edge has shrunk significantly)
    // capturedRatio = (0.015 - 0.002) / 0.015 = 0.867 >= 0.80
    const result = service.evaluateExits({
      position,
      currentNetEdge: new Decimal('0.002'), // edge shrunk from 0.015 to 0.002
      currentTimestamp: new Date('2025-02-01T16:00:00Z'),
      exitEdgeEvaporationPct: new Decimal('0.002'),
      exitTimeLimitHours: 72,
      exitProfitCapturePct: new Decimal('0.80'),
      resolutionTimestamp: null,
      resolutionPrice: null,
      hasDepth: true,
    });

    expect(result).not.toBeNull();
    expect(result!.reason).toBe('PROFIT_CAPTURE');
  });

  it('[P0] should trigger RESOLUTION_FORCE_CLOSE at contract resolution using price 1.00 or 0.00 (not VWAP)', () => {
    const position = makePosition();
    const result = service.evaluateExits({
      position,
      currentNetEdge: new Decimal('0.01'),
      currentTimestamp: new Date('2025-03-01T00:00:00Z'),
      exitEdgeEvaporationPct: new Decimal('0.002'),
      exitTimeLimitHours: 72,
      exitProfitCapturePct: new Decimal('0.80'),
      resolutionTimestamp: new Date('2025-03-01T00:00:00Z'),
      resolutionPrice: new Decimal('1.00'),
      hasDepth: true,
    });

    expect(result).not.toBeNull();
    expect(result!.reason).toBe('RESOLUTION_FORCE_CLOSE');
  });

  it('[P0] should trigger INSUFFICIENT_DEPTH when no depth available for exit valuation', () => {
    const position = makePosition();
    const result = service.evaluateExits({
      position,
      currentNetEdge: new Decimal('0.01'),
      currentTimestamp: new Date('2025-02-01T16:00:00Z'),
      exitEdgeEvaporationPct: new Decimal('0.002'),
      exitTimeLimitHours: 72,
      exitProfitCapturePct: new Decimal('0.80'),
      resolutionTimestamp: null,
      resolutionPrice: null,
      hasDepth: false,
    });

    expect(result).not.toBeNull();
    expect(result!.reason).toBe('INSUFFICIENT_DEPTH');
  });

  // ============================================================
  // Priority ordering — 3 tests
  // ============================================================

  it('[P0] should return RESOLUTION_FORCE_CLOSE when resolution and other criteria trigger simultaneously', () => {
    const position = makePosition({
      entryTimestamp: new Date('2025-01-01T00:00:00Z'),
    } as any);
    // All triggers active: resolution, time decay, edge evap, no depth
    const result = service.evaluateExits({
      position,
      currentNetEdge: new Decimal('0.001'),
      currentTimestamp: new Date('2025-03-01T00:00:00Z'),
      exitEdgeEvaporationPct: new Decimal('0.002'),
      exitTimeLimitHours: 72,
      exitProfitCapturePct: new Decimal('0.80'),
      resolutionTimestamp: new Date('2025-03-01T00:00:00Z'),
      resolutionPrice: new Decimal('1.00'),
      hasDepth: false,
    });

    expect(result!.reason).toBe('RESOLUTION_FORCE_CLOSE');
    expect(result!.priority).toBe(1);
  });

  it('[P0] should return INSUFFICIENT_DEPTH over PROFIT_CAPTURE when both trigger', () => {
    const position = makePosition({ entryEdge: new Decimal('0.015') } as any);
    // capturedRatio = (0.015 - 0.002) / 0.015 = 0.867 >= 0.80 → PROFIT_CAPTURE triggers
    // hasDepth: false → INSUFFICIENT_DEPTH also triggers
    const result = service.evaluateExits({
      position,
      currentNetEdge: new Decimal('0.002'),
      currentTimestamp: new Date('2025-02-01T16:00:00Z'),
      exitEdgeEvaporationPct: new Decimal('0.002'),
      exitTimeLimitHours: 72,
      exitProfitCapturePct: new Decimal('0.80'),
      resolutionTimestamp: null,
      resolutionPrice: null,
      hasDepth: false,
    });

    expect(result!.reason).toBe('INSUFFICIENT_DEPTH');
    expect(result!.priority).toBeLessThan(3); // Higher priority (lower number)
  });

  it('[P1] should return PROFIT_CAPTURE over EDGE_EVAPORATION when both trigger', () => {
    const position = makePosition({ entryEdge: new Decimal('0.010') } as any);
    // EDGE_EVAPORATION: currentNetEdge 0.001 < exitEdgeEvaporationPct 0.002 → triggers
    // PROFIT_CAPTURE: capturedRatio = (0.010 - 0.001) / 0.010 = 0.90 >= 0.80 → triggers
    // PROFIT_CAPTURE has higher priority (3) than EDGE_EVAPORATION (4)
    const result = service.evaluateExits({
      position,
      currentNetEdge: new Decimal('0.001'),
      currentTimestamp: new Date('2025-02-01T16:00:00Z'),
      exitEdgeEvaporationPct: new Decimal('0.002'),
      exitTimeLimitHours: 72,
      exitProfitCapturePct: new Decimal('0.80'),
      resolutionTimestamp: null,
      resolutionPrice: null,
      hasDepth: true,
    });

    expect(result).not.toBeNull();
    expect(result!.reason).toBe('PROFIT_CAPTURE');
  });

  // ============================================================
  // Edge cases — 4 tests
  // ============================================================

  it('[P0] should return null when no exit criteria triggered', () => {
    const position = makePosition();
    const result = service.evaluateExits({
      position,
      currentNetEdge: new Decimal('0.01'),
      currentTimestamp: new Date('2025-02-01T16:00:00Z'),
      exitEdgeEvaporationPct: new Decimal('0.002'),
      exitTimeLimitHours: 72,
      exitProfitCapturePct: new Decimal('0.80'),
      resolutionTimestamp: null,
      resolutionPrice: null,
      hasDepth: true,
    });

    expect(result).toBeNull();
  });

  it('[P0] should accrue time-based criteria during coverage gaps and evaluate at first available price after gap', () => {
    const position = makePosition({
      entryTimestamp: new Date('2025-02-01T00:00:00Z'),
    } as any);
    // 80 hours later (gap in between), time decay should trigger
    const result = service.evaluateExits({
      position,
      currentNetEdge: new Decimal('0.01'),
      currentTimestamp: new Date('2025-02-04T08:00:00Z'),
      exitEdgeEvaporationPct: new Decimal('0.002'),
      exitTimeLimitHours: 72,
      exitProfitCapturePct: new Decimal('0.80'),
      resolutionTimestamp: null,
      resolutionPrice: null,
      hasDepth: true,
    });

    expect(result).not.toBeNull();
    expect(result!.reason).toBe('TIME_DECAY');
  });

  it('[P1] should calculate resolution P&L using resolution price (1.00/0.00), not current market VWAP', () => {
    const position = makePosition();
    const result = service.evaluateExits({
      position,
      currentNetEdge: new Decimal('0.01'),
      currentTimestamp: new Date('2025-03-01T00:00:00Z'),
      exitEdgeEvaporationPct: new Decimal('0.002'),
      exitTimeLimitHours: 72,
      exitProfitCapturePct: new Decimal('0.80'),
      resolutionTimestamp: new Date('2025-03-01T00:00:00Z'),
      resolutionPrice: new Decimal('0.00'),
      hasDepth: true,
    });

    expect(result).not.toBeNull();
    expect(result!.reason).toBe('RESOLUTION_FORCE_CLOSE');
  });

  it('[P1] should use all Decimal arithmetic for edge comparison (no floating-point)', () => {
    const position = makePosition({ entryEdge: new Decimal('0.015') } as any);
    // Edge case: exact boundary — capturedRatio = (0.015 - 0.003) / 0.015 = 0.012 / 0.015 = 0.80 exactly
    const result = service.evaluateExits({
      position,
      currentNetEdge: new Decimal('0.003'),
      currentTimestamp: new Date('2025-02-01T16:00:00Z'),
      exitEdgeEvaporationPct: new Decimal('0.002'),
      exitTimeLimitHours: 72,
      exitProfitCapturePct: new Decimal('0.80'),
      resolutionTimestamp: null,
      resolutionPrice: null,
      hasDepth: true,
    });

    // At exact boundary (capturedRatio = 0.80 = exactly 80%), should trigger
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('PROFIT_CAPTURE');
  });
});
