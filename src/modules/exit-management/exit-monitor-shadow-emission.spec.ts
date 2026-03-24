import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import {
  createExitMonitorTestModule,
  createMockPosition,
  type ExitMonitorTestContext,
} from './exit-monitor.test-helpers';
import { EVENT_NAMES } from '../../common/events/event-catalog';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('ExitMonitorService — shadow comparison emission (Story 10.7.7)', () => {
  let service: ExitMonitorTestContext['service'];
  let positionRepository: ExitMonitorTestContext['positionRepository'];
  let eventEmitter: ExitMonitorTestContext['eventEmitter'];
  let thresholdEvaluator: ExitMonitorTestContext['thresholdEvaluator'];

  beforeEach(async () => {
    ({ service, positionRepository, eventEmitter, thresholdEvaluator } =
      await createExitMonitorTestModule());
    // Set shadow mode
    service.reloadConfig({ exitMode: 'shadow' });
  });

  function makeCriteria(overrides: Partial<{ edgeTrig: boolean }> = {}) {
    return [
      {
        criterion: 'edge_evaporation',
        proximity: new Decimal('0.75'),
        triggered: overrides.edgeTrig ?? false,
        detail: '',
      },
      {
        criterion: 'model_confidence',
        proximity: new Decimal('0.50'),
        triggered: false,
        detail: '',
      },
      {
        criterion: 'time_decay',
        proximity: new Decimal('0.30'),
        triggered: false,
        detail: '',
      },
      {
        criterion: 'risk_budget',
        proximity: new Decimal('0.10'),
        triggered: false,
        detail: '',
      },
      {
        criterion: 'liquidity_deterioration',
        proximity: new Decimal('0.05'),
        triggered: false,
        detail: '',
      },
      {
        criterion: 'profit_capture',
        proximity: new Decimal('0.60'),
        triggered: false,
        detail: '',
      },
    ];
  }

  function setupEvalResult(overrides: Record<string, unknown> = {}) {
    const criteria = overrides.criteria ?? makeCriteria();
    thresholdEvaluator.evaluate!.mockReturnValue({
      triggered: overrides.triggered ?? false,
      type: overrides.type,
      currentEdge: overrides.currentEdge ?? new Decimal('0.025'),
      currentPnl: overrides.currentPnl ?? new Decimal('0.01'),
      capturedEdgePercent: new Decimal('16.7'),
      shadowModelResult: overrides.shadowModelResult ?? {
        triggered: false,
        currentPnl: new Decimal('0.01'),
      },
      criteria,
    });
  }

  it('should emit shadow comparison with shadowDecision, modelDecision, agreement, currentEdge', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
    setupEvalResult({
      shadowModelResult: { triggered: false, currentPnl: new Decimal('0.01') },
    });

    await service.evaluatePositions();

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.SHADOW_COMPARISON,
      expect.objectContaining({
        shadowDecision: 'hold',
        modelDecision: 'hold',
        agreement: true,
        currentEdge: '0.02500000',
      }),
    );
  });

  it('should set agreement=true and divergenceDetail=null when both hold', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
    setupEvalResult({
      shadowModelResult: { triggered: false, currentPnl: new Decimal('0.01') },
    });

    await service.evaluatePositions();

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.SHADOW_COMPARISON,
      expect.objectContaining({
        agreement: true,
        divergenceDetail: null,
      }),
    );
  });

  it('should set agreement=true when both trigger (different types)', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
    setupEvalResult({
      triggered: true,
      type: 'stop_loss',
      shadowModelResult: {
        triggered: true,
        type: 'edge_evaporation',
        currentPnl: new Decimal('-0.05'),
      },
      criteria: makeCriteria({ edgeTrig: true }),
    });

    await service.evaluatePositions();

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.SHADOW_COMPARISON,
      expect.objectContaining({
        shadowDecision: 'exit:stop_loss',
        modelDecision: 'exit:edge_evaporation',
        agreement: true,
        divergenceDetail: null,
      }),
    );
  });

  it('should set agreement=false with divergenceDetail when fixed triggers but model holds', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
    setupEvalResult({
      triggered: true,
      type: 'stop_loss',
      shadowModelResult: { triggered: false, currentPnl: new Decimal('-0.05') },
      criteria: makeCriteria(),
    });

    await service.evaluatePositions();

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.SHADOW_COMPARISON,
      expect.objectContaining({
        shadowDecision: 'exit:stop_loss',
        modelDecision: 'hold',
        agreement: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        divergenceDetail: expect.objectContaining({
          triggeredCriteria: [],
          fixedType: 'stop_loss',
          modelType: null,
        }),
      }),
    );
  });

  it('should set agreement=false with divergenceDetail when model triggers but fixed holds', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
    setupEvalResult({
      triggered: false,
      shadowModelResult: {
        triggered: true,
        type: 'edge_evaporation',
        currentPnl: new Decimal('0.01'),
      },
      criteria: makeCriteria({ edgeTrig: true }),
    });

    await service.evaluatePositions();

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.SHADOW_COMPARISON,
      expect.objectContaining({
        shadowDecision: 'hold',
        modelDecision: 'exit:edge_evaporation',
        agreement: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        divergenceDetail: expect.objectContaining({
          triggeredCriteria: ['edge_evaporation'],
          fixedType: null,
          modelType: 'edge_evaporation',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          proximityValues: expect.objectContaining({
            edge_evaporation: '0.75000000',
          }),
        }),
      }),
    );
  });

  it('should format currentEdge with toFixed(8)', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
    setupEvalResult({
      currentEdge: new Decimal('0.003'),
      shadowModelResult: { triggered: false, currentPnl: new Decimal('0.01') },
    });

    await service.evaluatePositions();

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.SHADOW_COMPARISON,
      expect.objectContaining({
        currentEdge: '0.00300000',
      }),
    );
  });
});
