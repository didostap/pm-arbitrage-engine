import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ExecutionService } from './execution.service';
import { LegSequencingService } from './leg-sequencing.service';
import { DepthAnalysisService } from './depth-analysis.service';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { PlatformId } from '../../common/types/platform.type';
import { EXECUTION_ERROR_CODES } from '../../common/errors/execution-error';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { createMockPlatformConnector } from '../../test/mock-factories.js';
import { ComplianceValidatorService } from './compliance/compliance-validator.service';
import { PlatformHealthService } from '../data-ingestion/platform-health.service';
import { DataDivergenceService } from '../data-ingestion/data-divergence.service';
import { asOpportunityId, asPairId } from '../../common/types/branded.type';
import {
  makeKalshiOrderBook,
  makePolymarketOrderBook,
  makeOpportunity,
  makeReservation,
  makeFilledOrder,
  createConfigService,
} from './execution-test.helpers';

describe('ExecutionService', () => {
  let service: ExecutionService;
  let kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  let polymarketConnector: ReturnType<typeof createMockPlatformConnector>;
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let orderRepo: {
    create: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  let positionRepo: {
    create: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  let complianceValidator: {
    validate: ReturnType<typeof vi.fn>;
  };
  let configService: ReturnType<typeof createConfigService>;
  let platformHealthService: {
    getPlatformHealth: ReturnType<typeof vi.fn>;
  };
  let dataDivergenceService: {
    getDivergenceStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI, {
      getFeeSchedule: vi.fn().mockReturnValue({
        platformId: PlatformId.KALSHI,
        makerFeePercent: 0,
        takerFeePercent: 2.0,
        description: 'Kalshi fee schedule',
      }),
    });
    polymarketConnector = createMockPlatformConnector(PlatformId.POLYMARKET, {
      getFeeSchedule: vi.fn().mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        makerFeePercent: 0,
        takerFeePercent: 2.0,
        description: 'Polymarket fee schedule',
      }),
    });
    eventEmitter = { emit: vi.fn() };
    orderRepo = {
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        orderId: `order-${Date.now()}`,
        ...data,
      })),
      findById: vi.fn(),
    };
    positionRepo = {
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        positionId: `pos-${Date.now()}`,
        ...data,
      })),
      findById: vi.fn(),
    };
    complianceValidator = {
      validate: vi.fn().mockReturnValue({ approved: true, violations: [] }),
    };
    configService = createConfigService();
    platformHealthService = {
      getPlatformHealth: vi.fn().mockReturnValue({
        platformId: 'kalshi',
        status: 'healthy',
        latencyMs: null,
        lastHeartbeat: new Date(),
        mode: 'live',
      }),
    };
    dataDivergenceService = {
      getDivergenceStatus: vi.fn().mockReturnValue('normal'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutionService,
        LegSequencingService,
        DepthAnalysisService,
        { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
        { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: OrderRepository, useValue: orderRepo },
        { provide: PositionRepository, useValue: positionRepo },
        { provide: ComplianceValidatorService, useValue: complianceValidator },
        { provide: ConfigService, useValue: configService },
        { provide: PlatformHealthService, useValue: platformHealthService },
        { provide: DataDivergenceService, useValue: dataDivergenceService },
      ],
    }).compile();

    service = module.get<ExecutionService>(ExecutionService);
  });

  describe('happy path — two-leg fill', () => {
    it('should execute both legs and return success', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      expect(result.partialFill).toBe(false);
      expect(result.positionId).toBeDefined();
      expect(result.primaryOrder).toBeDefined();
      expect(result.secondaryOrder).toBeDefined();
    });

    it('should emit two OrderFilledEvents on two-leg fill', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(makeOpportunity(), makeReservation());

      const orderFilledCalls = eventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.ORDER_FILLED,
      );
      expect(orderFilledCalls).toHaveLength(2);
    });

    it('should persist two orders and one position', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(makeOpportunity(), makeReservation());

      expect(orderRepo.create).toHaveBeenCalledTimes(2);
      expect(positionRepo.create).toHaveBeenCalledTimes(1);

      const positionData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(positionData.status).toBe('OPEN');
    });
  });

  describe('isPaper flag propagation', () => {
    it('should set isPaper false when both connectors are live (no mode field)', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(makeOpportunity(), makeReservation());

      for (const call of orderRepo.create.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ isPaper: false }));
      }
      expect(positionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPaper: false }),
      );
    });

    it('should set isPaper true when primary connector health has mode paper', async () => {
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(makeOpportunity(), makeReservation());

      for (const call of orderRepo.create.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ isPaper: true }));
      }
      expect(positionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPaper: true }),
      );
    });

    it('should set isPaper true when secondary connector health has mode paper', async () => {
      polymarketConnector.getHealth.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(makeOpportunity(), makeReservation());

      for (const call of orderRepo.create.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ isPaper: true }));
      }
      expect(positionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPaper: true }),
      );
    });

    it('should return clean rejection when secondary depth fails (no single-leg with paper)', async () => {
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        asks: [],
        bids: [],
      });

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should set isPaper on pending secondary order persist before handleSingleLeg', async () => {
      polymarketConnector.getHealth.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET, {
          status: 'pending',
          filledQuantity: 0,
          filledPrice: 0,
        }),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(true);

      expect(orderRepo.create).toHaveBeenCalledTimes(2);
      for (const call of orderRepo.create.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ isPaper: true }));
      }
      const secondCall = orderRepo.create.mock.calls[1]![0] as Record<
        string,
        unknown
      >;
      expect(secondCall.status).toBe('PENDING');
      expect(positionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPaper: true }),
      );
    });
  });

  describe('primary leg fails', () => {
    it('should return success false and partialFill false when primary rejected', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI, { status: 'rejected' }),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
    });
  });

  describe('compliance gate', () => {
    it('should call compliance check before depth verification', async () => {
      complianceValidator.validate.mockReturnValue({
        approved: false,
        violations: [
          {
            platform: 'KALSHI',
            category: 'assassination',
            rule: 'Blocked category: assassination',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      await service.execute(
        makeOpportunity({
          pairConfig: { eventDescription: 'Assassination contract' },
        }),
        makeReservation(),
      );

      expect(complianceValidator.validate).toHaveBeenCalled();
      expect(kalshiConnector.getOrderBook).not.toHaveBeenCalled();
    });

    it('should return ExecutionError(2009) on compliance block', async () => {
      complianceValidator.validate.mockReturnValue({
        approved: false,
        violations: [
          {
            platform: 'KALSHI',
            category: 'terrorism',
            rule: 'Blocked category: terrorism',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(result.error?.code).toBe(EXECUTION_ERROR_CODES.COMPLIANCE_BLOCKED);
    });

    it('should proceed to depth verification on compliance approval', async () => {
      complianceValidator.validate.mockReturnValue({
        approved: true,
        violations: [],
      });
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(complianceValidator.validate).toHaveBeenCalled();
      expect(kalshiConnector.getOrderBook).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should pass correct context to compliance validator', async () => {
      complianceValidator.validate.mockReturnValue({
        approved: false,
        violations: [
          {
            platform: 'KALSHI',
            category: 'test',
            rule: 'test',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      await service.execute(
        makeOpportunity({
          pairConfig: {
            eventDescription: 'Test event description',
            kalshiContractId: 'kalshi-c1',
            polymarketContractId: 'pm-c1',
          },
        }),
        makeReservation(),
      );

      expect(complianceValidator.validate).toHaveBeenCalledWith(
        expect.objectContaining({
          pairId: asPairId('pair-1'),
          opportunityId: asOpportunityId('opp-1'),
          primaryPlatform: PlatformId.KALSHI,
          secondaryPlatform: PlatformId.POLYMARKET,
          eventDescription: 'Test event description',
          kalshiContractId: 'kalshi-c1',
          polymarketContractId: 'pm-c1',
        }),
        false,
        false,
      );
    });

    it('should not trigger single-leg handling on compliance failure', async () => {
      complianceValidator.validate.mockReturnValue({
        approved: false,
        violations: [
          {
            platform: 'KALSHI',
            category: 'terrorism',
            rule: 'Blocked category: terrorism',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
      const singleLegEmit = eventEmitter.emit.mock.calls.find(
        (call: unknown[]) => call[0] === EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      );
      expect(singleLegEmit).toBeUndefined();
    });

    it('should fail safely when compliance validator throws', async () => {
      complianceValidator.validate.mockImplementation(() => {
        throw new Error('Unexpected compliance error');
      });

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(EXECUTION_ERROR_CODES.COMPLIANCE_BLOCKED);
      expect(result.error?.message).toContain('Compliance validation error');
    });
  });

  describe('EXECUTION_MIN_FILL_RATIO config validation', () => {
    it('should use default value 0.25 when not configured', async () => {
      const cs = createConfigService();
      const mod = await Test.createTestingModule({
        providers: [
          ExecutionService,
          LegSequencingService,
          DepthAnalysisService,
          { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
          {
            provide: POLYMARKET_CONNECTOR_TOKEN,
            useValue: polymarketConnector,
          },
          { provide: EventEmitter2, useValue: eventEmitter },
          { provide: OrderRepository, useValue: orderRepo },
          { provide: PositionRepository, useValue: positionRepo },
          {
            provide: ComplianceValidatorService,
            useValue: complianceValidator,
          },
          { provide: ConfigService, useValue: cs },
          { provide: PlatformHealthService, useValue: platformHealthService },
          { provide: DataDivergenceService, useValue: dataDivergenceService },
        ],
      }).compile();
      expect(mod.get<ExecutionService>(ExecutionService)).toBeDefined();
    });

    it('should accept custom value from config', async () => {
      const cs = createConfigService({ EXECUTION_MIN_FILL_RATIO: '0.5' });
      const mod = await Test.createTestingModule({
        providers: [
          ExecutionService,
          LegSequencingService,
          DepthAnalysisService,
          { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
          {
            provide: POLYMARKET_CONNECTOR_TOKEN,
            useValue: polymarketConnector,
          },
          { provide: EventEmitter2, useValue: eventEmitter },
          { provide: OrderRepository, useValue: orderRepo },
          { provide: PositionRepository, useValue: positionRepo },
          {
            provide: ComplianceValidatorService,
            useValue: complianceValidator,
          },
          { provide: ConfigService, useValue: cs },
          { provide: PlatformHealthService, useValue: platformHealthService },
          { provide: DataDivergenceService, useValue: dataDivergenceService },
        ],
      }).compile();
      expect(mod.get<ExecutionService>(ExecutionService)).toBeDefined();
    });

    it('should throw on invalid value 0', async () => {
      const cs = createConfigService({ EXECUTION_MIN_FILL_RATIO: '0' });
      await expect(
        Test.createTestingModule({
          providers: [
            ExecutionService,
            LegSequencingService,
            DepthAnalysisService,
            { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
            {
              provide: POLYMARKET_CONNECTOR_TOKEN,
              useValue: polymarketConnector,
            },
            { provide: EventEmitter2, useValue: eventEmitter },
            { provide: OrderRepository, useValue: orderRepo },
            { provide: PositionRepository, useValue: positionRepo },
            {
              provide: ComplianceValidatorService,
              useValue: complianceValidator,
            },
            { provide: ConfigService, useValue: cs },
            { provide: PlatformHealthService, useValue: platformHealthService },
            { provide: DataDivergenceService, useValue: dataDivergenceService },
          ],
        }).compile(),
      ).rejects.toThrow('Invalid EXECUTION_MIN_FILL_RATIO');
    });

    it('should throw on invalid value > 1', async () => {
      const cs = createConfigService({ EXECUTION_MIN_FILL_RATIO: '1.5' });
      await expect(
        Test.createTestingModule({
          providers: [
            ExecutionService,
            LegSequencingService,
            DepthAnalysisService,
            { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
            {
              provide: POLYMARKET_CONNECTOR_TOKEN,
              useValue: polymarketConnector,
            },
            { provide: EventEmitter2, useValue: eventEmitter },
            { provide: OrderRepository, useValue: orderRepo },
            { provide: PositionRepository, useValue: positionRepo },
            {
              provide: ComplianceValidatorService,
              useValue: complianceValidator,
            },
            { provide: ConfigService, useValue: cs },
            { provide: PlatformHealthService, useValue: platformHealthService },
            { provide: DataDivergenceService, useValue: dataDivergenceService },
          ],
        }).compile(),
      ).rejects.toThrow('Invalid EXECUTION_MIN_FILL_RATIO');
    });

    it('should throw on NaN value', async () => {
      const cs = createConfigService({ EXECUTION_MIN_FILL_RATIO: 'abc' });
      await expect(
        Test.createTestingModule({
          providers: [
            ExecutionService,
            LegSequencingService,
            DepthAnalysisService,
            { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
            {
              provide: POLYMARKET_CONNECTOR_TOKEN,
              useValue: polymarketConnector,
            },
            { provide: EventEmitter2, useValue: eventEmitter },
            { provide: OrderRepository, useValue: orderRepo },
            { provide: PositionRepository, useValue: positionRepo },
            {
              provide: ComplianceValidatorService,
              useValue: complianceValidator,
            },
            { provide: ConfigService, useValue: cs },
            { provide: PlatformHealthService, useValue: platformHealthService },
            { provide: DataDivergenceService, useValue: dataDivergenceService },
          ],
        }).compile(),
      ).rejects.toThrow('Invalid EXECUTION_MIN_FILL_RATIO');
    });

    it('should throw on negative value', async () => {
      const cs = createConfigService({ EXECUTION_MIN_FILL_RATIO: '-0.1' });
      await expect(
        Test.createTestingModule({
          providers: [
            ExecutionService,
            LegSequencingService,
            DepthAnalysisService,
            { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
            {
              provide: POLYMARKET_CONNECTOR_TOKEN,
              useValue: polymarketConnector,
            },
            { provide: EventEmitter2, useValue: eventEmitter },
            { provide: OrderRepository, useValue: orderRepo },
            { provide: PositionRepository, useValue: positionRepo },
            {
              provide: ComplianceValidatorService,
              useValue: complianceValidator,
            },
            { provide: ConfigService, useValue: cs },
            { provide: PlatformHealthService, useValue: platformHealthService },
            { provide: DataDivergenceService, useValue: dataDivergenceService },
          ],
        }).compile(),
      ).rejects.toThrow('Invalid EXECUTION_MIN_FILL_RATIO');
    });

    it('should throw on invalid DETECTION_MIN_EDGE_THRESHOLD (non-numeric)', async () => {
      const cs = createConfigService({
        DETECTION_MIN_EDGE_THRESHOLD: 'not-a-number',
      });
      await expect(
        Test.createTestingModule({
          providers: [
            ExecutionService,
            LegSequencingService,
            DepthAnalysisService,
            { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
            {
              provide: POLYMARKET_CONNECTOR_TOKEN,
              useValue: polymarketConnector,
            },
            { provide: EventEmitter2, useValue: eventEmitter },
            { provide: OrderRepository, useValue: orderRepo },
            { provide: PositionRepository, useValue: positionRepo },
            {
              provide: ComplianceValidatorService,
              useValue: complianceValidator,
            },
            { provide: ConfigService, useValue: cs },
            { provide: PlatformHealthService, useValue: platformHealthService },
            { provide: DataDivergenceService, useValue: dataDivergenceService },
          ],
        }).compile(),
      ).rejects.toThrow('Invalid DETECTION_MIN_EDGE_THRESHOLD');
    });

    it('should throw on invalid DETECTION_MIN_EDGE_THRESHOLD (zero)', async () => {
      const cs = createConfigService({ DETECTION_MIN_EDGE_THRESHOLD: '0' });
      await expect(
        Test.createTestingModule({
          providers: [
            ExecutionService,
            LegSequencingService,
            DepthAnalysisService,
            { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
            {
              provide: POLYMARKET_CONNECTOR_TOKEN,
              useValue: polymarketConnector,
            },
            { provide: EventEmitter2, useValue: eventEmitter },
            { provide: OrderRepository, useValue: orderRepo },
            { provide: PositionRepository, useValue: positionRepo },
            {
              provide: ComplianceValidatorService,
              useValue: complianceValidator,
            },
            { provide: ConfigService, useValue: cs },
            { provide: PlatformHealthService, useValue: platformHealthService },
            { provide: DataDivergenceService, useValue: dataDivergenceService },
          ],
        }).compile(),
      ).rejects.toThrow('Invalid DETECTION_MIN_EDGE_THRESHOLD');
    });
  });
});
