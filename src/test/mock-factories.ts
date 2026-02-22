import { vi } from 'vitest';
import { PlatformId } from '../common/types/platform.type.js';

/**
 * Creates a complete mock of IPlatformConnector with sensible defaults.
 * All methods are vi.fn() — unused methods are harmless no-ops.
 */
export const createMockPlatformConnector = (
  platformId: PlatformId = PlatformId.KALSHI,
  overrides: Record<string, unknown> = {},
) => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getPlatformId: vi.fn().mockReturnValue(platformId),
  getHealth: vi.fn().mockReturnValue({
    platformId,
    status: 'healthy' as const,
    lastHeartbeat: new Date(),
    latencyMs: 50,
  }),
  getOrderBook: vi.fn(),
  submitOrder: vi.fn(),
  cancelOrder: vi.fn(),
  getOrder: vi.fn(),
  getPositions: vi.fn(),
  getFeeSchedule: vi.fn().mockReturnValue({
    platformId,
    makerFeePercent: 0,
    takerFeePercent: platformId === PlatformId.KALSHI ? 0 : 2,
    description: `${platformId} fees`,
  }),
  onOrderBookUpdate: vi.fn(),
  ...overrides,
});

/**
 * Creates a complete mock of IRiskManager with sensible defaults.
 * All methods are vi.fn() — unused methods are harmless no-ops.
 */
export const createMockRiskManager = (
  overrides: Record<string, unknown> = {},
) => ({
  validatePosition: vi.fn().mockResolvedValue({
    approved: true,
    reason: 'mock-approved',
  }),
  getCurrentExposure: vi.fn().mockReturnValue({
    totalCapitalDeployed: 0,
    openPositionCount: 0,
    dailyPnl: 0,
  }),
  getOpenPositionCount: vi.fn().mockReturnValue(0),
  updateDailyPnl: vi.fn().mockResolvedValue(undefined),
  isTradingHalted: vi.fn().mockReturnValue(false),
  haltTrading: vi.fn(),
  resumeTrading: vi.fn(),
  recalculateFromPositions: vi.fn().mockResolvedValue(undefined),
  processOverride: vi.fn(),
  reserveBudget: vi.fn(),
  commitReservation: vi.fn().mockResolvedValue(undefined),
  releaseReservation: vi.fn().mockResolvedValue(undefined),
  closePosition: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

/**
 * Creates a complete mock of IExecutionEngine with sensible defaults.
 */
export const createMockExecutionEngine = (
  overrides: Record<string, unknown> = {},
) => ({
  execute: vi.fn().mockResolvedValue({
    success: false,
    positionId: undefined,
    error: undefined,
  }),
  ...overrides,
});
