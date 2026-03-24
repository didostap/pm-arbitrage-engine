import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import {
  createExitMonitorTestModule,
  createMockPosition,
  setupOrderCreateMock,
  type ExitMonitorTestContext,
} from '../../../../modules/exit-management/exit-monitor.test-helpers';
import { asPositionId } from '../../../types/branded.type';
import { PlatformId } from '../../../types/platform.type';

vi.mock('../../../services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

function getClosePositionPnl(
  positionRepository: ExitMonitorTestContext['positionRepository'],
): Decimal | undefined {
  const calls = (positionRepository.closePosition as ReturnType<typeof vi.fn>)
    .mock.calls as [string, Decimal][];
  return calls[0]?.[1];
}

describe('ExitMonitor — Paper/Live PnL Persistence Boundary (Story 10-7-4)', () => {
  let ctx: ExitMonitorTestContext;

  beforeEach(async () => {
    ctx = await createExitMonitorTestModule();
  });

  function setConnectorMode(mode: 'paper' | 'live') {
    ctx.kalshiConnector.getHealth.mockReturnValue({
      platformId: PlatformId.KALSHI,
      status: 'healthy' as const,
      lastHeartbeat: new Date(),
      latencyMs: 50,
      mode,
    });
    ctx.polymarketConnector.getHealth.mockReturnValue({
      platformId: PlatformId.POLYMARKET,
      status: 'healthy' as const,
      lastHeartbeat: new Date(),
      latencyMs: 50,
      mode,
    });
  }

  describe.each([
    [true, 'paper'],
    [false, 'live'],
  ] as const)('isPaper=%s (%s mode)', (isPaper, modeLabel) => {
    beforeEach(() => {
      setConnectorMode(modeLabel);
    });

    it(`[P1][S13/S14] should persist realizedPnl in ${modeLabel} mode full exit`, async () => {
      const position = createMockPosition({ isPaper });
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

      // Both paper and live mode must persist realizedPnl via repository
      expect(ctx.positionRepository.closePosition).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        expect.any(Decimal),
      );

      // Verify realizedPnl is a valid finite Decimal
      const pnl = getClosePositionPnl(ctx.positionRepository);
      expect(pnl).toBeDefined();
      expect(pnl!.isFinite()).toBe(true);
    });

    it(`[P1] should pass correct isPaper=${isPaper} to risk manager in ${modeLabel} mode`, async () => {
      const position = createMockPosition({ isPaper });
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

      // Risk manager should receive correct isPaper flag
      expect(ctx.riskManager.closePosition).toHaveBeenCalledWith(
        expect.any(Decimal),
        expect.any(Decimal),
        expect.anything(),
        isPaper,
      );
    });
  });
});
