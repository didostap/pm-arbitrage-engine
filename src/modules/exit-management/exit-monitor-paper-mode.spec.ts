import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createExitMonitorTestModule,
  type ExitMonitorTestContext,
} from './exit-monitor.test-helpers';
import { PlatformId } from '../../common/types/platform.type';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('ExitMonitorService — paper mode', () => {
  let service: ExitMonitorTestContext['service'];
  let positionRepository: ExitMonitorTestContext['positionRepository'];
  let kalshiConnector: ExitMonitorTestContext['kalshiConnector'];
  let polymarketConnector: ExitMonitorTestContext['polymarketConnector'];

  beforeEach(async () => {
    ({ service, positionRepository, kalshiConnector, polymarketConnector } =
      await createExitMonitorTestModule());
  });

  describe('paper mode support', () => {
    function setPaperMode() {
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'healthy' as const,
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
      polymarketConnector.getHealth.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        status: 'healthy' as const,
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
    }

    function setMixedMode() {
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'healthy' as const,
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
      polymarketConnector.getHealth.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        status: 'healthy' as const,
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'live',
      });
    }

    describe('evaluatePositions mode-aware query', () => {
      it('should pass isPaper=true to repository when in paper mode', async () => {
        setPaperMode();
        positionRepository.findByStatusWithOrders!.mockResolvedValue([]);

        await service.evaluatePositions();

        expect(positionRepository.findByStatusWithOrders).toHaveBeenCalledWith(
          { in: ['OPEN', 'EXIT_PARTIAL'] },
          true,
        );
      });

      it('should pass isPaper=false to repository when in live mode', async () => {
        // Default mock health has no mode field (undefined = live)
        positionRepository.findByStatusWithOrders!.mockResolvedValue([]);

        await service.evaluatePositions();

        expect(positionRepository.findByStatusWithOrders).toHaveBeenCalledWith(
          { in: ['OPEN', 'EXIT_PARTIAL'] },
          false,
        );
      });

      it('should pass isPaper=true to repository when in mixed mode', async () => {
        setMixedMode();
        positionRepository.findByStatusWithOrders!.mockResolvedValue([]);

        await service.evaluatePositions();

        expect(positionRepository.findByStatusWithOrders).toHaveBeenCalledWith(
          { in: ['OPEN', 'EXIT_PARTIAL'] },
          true,
        );
      });
    });
  });
});
