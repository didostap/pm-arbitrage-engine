import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import {
  createExitMonitorTestModule,
  createMockPosition,
  type ExitMonitorTestContext,
} from './exit-monitor.test-helpers';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('ExitMonitorService — pricing', () => {
  let service: ExitMonitorTestContext['service'];
  let positionRepository: ExitMonitorTestContext['positionRepository'];
  let kalshiConnector: ExitMonitorTestContext['kalshiConnector'];
  let polymarketConnector: ExitMonitorTestContext['polymarketConnector'];
  let thresholdEvaluator: ExitMonitorTestContext['thresholdEvaluator'];

  beforeEach(async () => {
    ({
      service,
      positionRepository,
      kalshiConnector,
      polymarketConnector,
      thresholdEvaluator,
    } = await createExitMonitorTestModule());
  });

  describe('entry close price forwarding (6.5.5i)', () => {
    it('should forward entry close prices and fee rates to threshold evaluator', async () => {
      const position = createMockPosition({
        entryClosePriceKalshi: new Decimal('0.60'),
        entryClosePricePolymarket: new Decimal('0.67'),
        entryKalshiFeeRate: new Decimal('0.02'),
        entryPolymarketFeeRate: new Decimal('0.015'),
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      kalshiConnector.getHealth.mockReturnValue({ status: 'connected' });
      polymarketConnector.getHealth.mockReturnValue({ status: 'connected' });

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          entryClosePriceKalshi: expect.any(Decimal) as unknown,
          entryClosePricePolymarket: expect.any(Decimal) as unknown,
          entryKalshiFeeRate: expect.any(Decimal) as unknown,
          entryPolymarketFeeRate: expect.any(Decimal) as unknown,
        }),
      );

      const evalInput = thresholdEvaluator.evaluate.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect((evalInput.entryClosePriceKalshi as Decimal).toString()).toBe(
        '0.6',
      );
      expect((evalInput.entryClosePricePolymarket as Decimal).toString()).toBe(
        '0.67',
      );
      expect((evalInput.entryKalshiFeeRate as Decimal).toString()).toBe('0.02');
      expect((evalInput.entryPolymarketFeeRate as Decimal).toString()).toBe(
        '0.015',
      );
    });

    it('should forward null values for legacy positions', async () => {
      const position = createMockPosition({
        entryClosePriceKalshi: null,
        entryClosePricePolymarket: null,
        entryKalshiFeeRate: null,
        entryPolymarketFeeRate: null,
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      kalshiConnector.getHealth.mockReturnValue({ status: 'connected' });
      polymarketConnector.getHealth.mockReturnValue({ status: 'connected' });

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          entryClosePriceKalshi: null,
          entryClosePricePolymarket: null,
          entryKalshiFeeRate: null,
          entryPolymarketFeeRate: null,
        }),
      );
    });
  });
});
