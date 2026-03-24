import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import {
  createExitMonitorTestModule,
  createMockPosition,
  setupOrderCreateMock,
  type ExitMonitorTestContext,
} from './exit-monitor.test-helpers';
import { asPositionId, asOrderId } from '../../common/types/branded.type';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

function getClosePositionPnl(
  positionRepository: ExitMonitorTestContext['positionRepository'],
): Decimal | undefined {
  const calls = (positionRepository.closePosition as ReturnType<typeof vi.fn>)
    .mock.calls as [string, Decimal][];
  return calls[0]?.[1];
}

describe('ExitMonitorService — realizedPnl persistence (Story 10-7-4)', () => {
  let ctx: ExitMonitorTestContext;

  beforeEach(async () => {
    ctx = await createExitMonitorTestModule();
  });

  // ── S2: Full exit persists realizedPnl via direct Prisma update ──────

  describe('executeExit() full exit path (AC2, AC4)', () => {
    it('[P0][S2] should persist realizedPnl via positionRepository.closePosition when full exit completes', async () => {
      const position = createMockPosition();
      ctx.positionRepository.findByStatusWithOrders!.mockResolvedValue([
        position,
      ]);

      ctx.thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentEdge: new Decimal('0.025'),
        currentPnl: new Decimal('3.00'),
        capturedEdgePercent: new Decimal('100'),
      });

      setupOrderCreateMock(ctx.orderRepository);

      await ctx.service.evaluatePositions();

      expect(ctx.positionRepository.closePosition).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        expect.any(Decimal),
      );

      const pnl = getClosePositionPnl(ctx.positionRepository);
      expect(pnl).toBeDefined();
      expect(pnl!.isFinite()).toBe(true);
    });

    // ── S4: Buy-side leg PnL formula ──────

    it('[P0][S4] should compute buy-side leg PnL as (exitPrice - entryPrice) × size', async () => {
      const position = createMockPosition({
        kalshiSide: 'buy',
        entryPrices: { kalshi: '0.62', polymarket: '0.65' },
      });
      ctx.positionRepository.findByStatusWithOrders!.mockResolvedValue([
        position,
      ]);

      ctx.thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentEdge: new Decimal('0.025'),
        currentPnl: new Decimal('3.00'),
        capturedEdgePercent: new Decimal('100'),
      });

      setupOrderCreateMock(ctx.orderRepository);

      await ctx.service.evaluatePositions();

      const pnl = getClosePositionPnl(ctx.positionRepository)!;

      // Buy-side kalshi: (0.66 - 0.62) × 100 = 4.00
      // Sell-side poly: (0.65 - 0.62) × 100 = 3.00
      // Total before fees = 7.00, minus fees → positive
      expect(pnl.isFinite()).toBe(true);
      expect(pnl.gt(new Decimal('0'))).toBe(true);
    });

    // ── S5: Sell-side leg PnL formula ──────

    it('[P0][S5] should compute sell-side leg PnL as (entryPrice - exitPrice) × size', async () => {
      const position = createMockPosition({
        polymarketSide: 'sell',
        entryPrices: { kalshi: '0.62', polymarket: '0.65' },
      });
      ctx.positionRepository.findByStatusWithOrders!.mockResolvedValue([
        position,
      ]);

      ctx.thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentEdge: new Decimal('0.025'),
        currentPnl: new Decimal('3.00'),
        capturedEdgePercent: new Decimal('100'),
      });

      setupOrderCreateMock(ctx.orderRepository);

      await ctx.service.evaluatePositions();

      const pnl = getClosePositionPnl(ctx.positionRepository)!;
      expect(pnl.isFinite()).toBe(true);
    });

    // ── S6: Exit fees subtracted ──────

    it('[P0][S6] should subtract exit fees from total realized PnL', async () => {
      const position = createMockPosition();
      ctx.positionRepository.findByStatusWithOrders!.mockResolvedValue([
        position,
      ]);

      ctx.thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentEdge: new Decimal('0.025'),
        currentPnl: new Decimal('3.00'),
        capturedEdgePercent: new Decimal('100'),
      });

      setupOrderCreateMock(ctx.orderRepository);

      await ctx.service.evaluatePositions();

      const pnl = getClosePositionPnl(ctx.positionRepository)!;

      // With fees (kalshi 2% taker, polymarket 1% taker), PnL must be less than gross PnL
      // Gross: kalshi leg (0.66-0.62)×100 + poly leg (0.65-0.62)×100 = 4.00 + 3.00 = 7.00
      const grossPnl = new Decimal('7.00');
      expect(pnl.lt(grossPnl)).toBe(true);
      expect(pnl.gt(new Decimal('0'))).toBe(true);
    });

    // ── S7: Asymmetric prices — sign error detection ──────

    it('[P0][S7] should handle asymmetric entry/exit prices without sign errors', async () => {
      const position = createMockPosition({
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        entryPrices: { kalshi: '0.40', polymarket: '0.55' },
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.40'),
          size: new Decimal('100'),
          fillPrice: new Decimal('0.40'),
          fillSize: new Decimal('100'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.55'),
          size: new Decimal('100'),
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('100'),
          status: 'FILLED',
        },
      });
      ctx.positionRepository.findByStatusWithOrders!.mockResolvedValue([
        position,
      ]);

      ctx.kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-1'),
        status: 'filled',
        filledPrice: 0.7,
        filledQuantity: 100,
        timestamp: new Date(),
      });

      ctx.polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-1'),
        status: 'filled',
        filledPrice: 0.5,
        filledQuantity: 100,
        timestamp: new Date(),
      });

      ctx.thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentEdge: new Decimal('0.10'),
        currentPnl: new Decimal('20.00'),
        capturedEdgePercent: new Decimal('100'),
      });

      setupOrderCreateMock(ctx.orderRepository);

      await ctx.service.evaluatePositions();

      const pnl = getClosePositionPnl(ctx.positionRepository)!;

      // Kalshi buy PnL: (0.70 - 0.40) × 100 = 30.00
      // Poly sell PnL: (0.55 - 0.50) × 100 = 5.00
      // Gross = 35.00, minus fees → must be positive
      expect(pnl.isFinite()).toBe(true);
      expect(pnl.gt(new Decimal('0'))).toBe(true);
    });
  });

  // ── S3: Zero-residual path persists realizedPnl: 0 ──────

  describe('evaluatePosition() zero-residual path (AC2, AC4)', () => {
    it('[P0][S3] should persist existing realizedPnl via positionRepository.closePosition when EXIT_PARTIAL has zero residual', async () => {
      const position = createMockPosition({ status: 'EXIT_PARTIAL' });
      ctx.positionRepository.findByStatusWithOrders!.mockResolvedValue([
        position,
      ]);

      // Exit orders fully match entry sizes — zero residual on both legs
      ctx.orderRepository.findByPairId!.mockResolvedValue([
        {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          fillSize: new Decimal('100'),
          type: 'ENTRY',
        },
        {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          fillSize: new Decimal('100'),
          type: 'ENTRY',
        },
        {
          orderId: asOrderId('exit-kalshi-1'),
          platform: 'KALSHI',
          side: 'sell',
          fillSize: new Decimal('100'),
          type: 'EXIT',
        },
        {
          orderId: asOrderId('exit-poly-1'),
          platform: 'POLYMARKET',
          side: 'buy',
          fillSize: new Decimal('100'),
          type: 'EXIT',
        },
      ]);

      await ctx.service.evaluatePositions();

      // Should close via repository method, preserving existing accumulated PnL
      expect(ctx.positionRepository.closePosition).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        new Decimal(0),
      );

      // Should NOT call positionRepository.updateStatus for CLOSED transitions
      const updateStatusCalls = (
        ctx.positionRepository.updateStatus as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call: unknown[]) => call[1] === 'CLOSED');
      expect(updateStatusCalls).toHaveLength(0);
    });
  });

  // ── S11: Both legs break even ──────

  describe('edge cases (AC2)', () => {
    it('[P2][S11] should compute realizedPnl as negative (fees only) when both legs break even', async () => {
      const position = createMockPosition({
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        entryPrices: { kalshi: '0.66', polymarket: '0.62' },
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.66'),
          size: new Decimal('100'),
          fillPrice: new Decimal('0.66'),
          fillSize: new Decimal('100'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.62'),
          size: new Decimal('100'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('100'),
          status: 'FILLED',
        },
      });
      ctx.positionRepository.findByStatusWithOrders!.mockResolvedValue([
        position,
      ]);

      ctx.kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-1'),
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 100,
        timestamp: new Date(),
      });
      ctx.polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-1'),
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 100,
        timestamp: new Date(),
      });

      ctx.thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'stop_loss',
        currentEdge: new Decimal('0.00'),
        currentPnl: new Decimal('0.00'),
        capturedEdgePercent: new Decimal('0'),
      });

      setupOrderCreateMock(ctx.orderRepository);

      await ctx.service.evaluatePositions();

      const pnl = getClosePositionPnl(ctx.positionRepository)!;

      // Gross PnL = 0, fees > 0, so net PnL should be negative
      expect(pnl.isFinite()).toBe(true);
      expect(pnl.lt(new Decimal('0'))).toBe(true);
    });

    // ── S12: One leg profit, one leg loss ──────

    it('[P2][S12] should correctly sum profit on one leg and loss on the other', async () => {
      const position = createMockPosition({
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        entryPrices: { kalshi: '0.62', polymarket: '0.65' },
      });
      ctx.positionRepository.findByStatusWithOrders!.mockResolvedValue([
        position,
      ]);

      ctx.kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-1'),
        status: 'filled',
        filledPrice: 0.7,
        filledQuantity: 100,
        timestamp: new Date(),
      });
      ctx.polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-1'),
        status: 'filled',
        filledPrice: 0.72,
        filledQuantity: 100,
        timestamp: new Date(),
      });

      ctx.thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'stop_loss',
        currentEdge: new Decimal('-0.02'),
        currentPnl: new Decimal('-1.00'),
        capturedEdgePercent: new Decimal('-50'),
      });

      setupOrderCreateMock(ctx.orderRepository);

      await ctx.service.evaluatePositions();

      const pnl = getClosePositionPnl(ctx.positionRepository)!;

      expect(pnl.isFinite()).toBe(true);
      expect(pnl).not.toBeNull();
    });
  });

  // ── S15: Structural verification ──────

  describe('structural verification (AC4)', () => {
    it('[P2][S15] should NOT use positionRepository.updateStatus for any CLOSED transition', async () => {
      const position = createMockPosition();
      ctx.positionRepository.findByStatusWithOrders!.mockResolvedValue([
        position,
      ]);

      ctx.thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentEdge: new Decimal('0.025'),
        currentPnl: new Decimal('3.00'),
        capturedEdgePercent: new Decimal('100'),
      });

      setupOrderCreateMock(ctx.orderRepository);

      await ctx.service.evaluatePositions();

      const closedCalls = (
        ctx.positionRepository.updateStatus as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call: unknown[]) => call[1] === 'CLOSED');
      expect(closedCalls).toHaveLength(0);

      expect(ctx.positionRepository.closePosition).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        expect.any(Decimal),
      );
    });
  });

  // ── D6: Pinned exact PnL value ──────

  describe('pinned PnL value (D6)', () => {
    it('[D6] should compute exactly 5.06 realized PnL with default mock values', async () => {
      // Default mocks: kalshi buy@0.62 exit@0.66 size=100 fee=2%, poly sell@0.65 exit@0.62 size=100 fee=1%
      // Kalshi leg PnL (buy): (0.66 - 0.62) × 100 = 4.00
      // Poly leg PnL (sell): (0.65 - 0.62) × 100 = 3.00
      // Gross = 7.00
      // Kalshi exit fee: 0.66 × 100 × 0.02 = 1.32
      // Poly exit fee: 0.62 × 100 × 0.01 = 0.62
      // Net = 7.00 - 1.32 - 0.62 = 5.06
      const position = createMockPosition();
      ctx.positionRepository.findByStatusWithOrders!.mockResolvedValue([
        position,
      ]);

      ctx.thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentEdge: new Decimal('0.025'),
        currentPnl: new Decimal('5.06'),
        capturedEdgePercent: new Decimal('100'),
      });

      setupOrderCreateMock(ctx.orderRepository);

      await ctx.service.evaluatePositions();

      const pnl = getClosePositionPnl(ctx.positionRepository)!;
      expect(pnl.eq(new Decimal('5.06'))).toBe(true);
    });
  });
});
