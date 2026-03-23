/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
/**
 * Story 10-5-4 — AC2: Event Wiring Audit
 *
 * Verifies ALL @OnEvent handlers are wired to their events via real EventEmitter2.
 * Uses expectEventHandled() integration helper — not mocks.
 *
 * Handler inventory: 14 non-gateway + 22 gateway = 36 event subscriptions
 */
import { describe, it, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import {
  expectEventHandled,
  expectNoDeadHandlers,
} from './expect-event-handled';
import { EVENT_NAMES } from '../events/event-catalog';
import { BaseEvent } from '../events/base.event';

// Services under test
import { MatchAprUpdaterService } from '../../modules/monitoring/match-apr-updater.service';
import { CorrelationTrackerService } from '../../modules/risk-management/correlation-tracker.service';
import { AutoUnwindService } from '../../modules/execution/auto-unwind.service';
import { ExposureTrackerService } from '../../modules/execution/exposure-tracker.service';
import { ShadowComparisonService } from '../../modules/exit-management/shadow-comparison.service';
import { DataIngestionService } from '../../modules/data-ingestion/data-ingestion.service';
import { TradingEngineService } from '../../core/trading-engine.service';
import { ConfigAccessor } from '../config/config-accessor.service';
import { DashboardGateway } from '../../dashboard/dashboard.gateway';

// Dependencies (for mock provider tokens)
import { PrismaService } from '../prisma.service';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import { EngineConfigRepository } from '../../persistence/repositories/engine-config.repository';
import { SingleLegResolutionService } from '../../modules/execution/single-leg-resolution.service';
import { DetectionService } from '../../modules/arbitrage-detection/detection.service';
import { EdgeCalculatorService } from '../../modules/arbitrage-detection/edge-calculator.service';
import { KalshiConnector } from '../../connectors/kalshi/kalshi.connector';
import { PolymarketConnector } from '../../connectors/polymarket/polymarket.connector';
import { PlatformHealthService } from '../../modules/data-ingestion/platform-health.service';
import { DegradationProtocolService } from '../../modules/data-ingestion/degradation-protocol.service';
import { ContractPairLoaderService } from '../../modules/contract-matching/contract-pair-loader.service';
import { DataDivergenceService } from '../../modules/data-ingestion/data-divergence.service';
import { DashboardEventMapperService } from '../../dashboard/dashboard-event-mapper.service';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { EXECUTION_QUEUE_TOKEN } from '../../modules/execution/execution.constants';

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

/** Minimal event payload for wiring verification */
const testPayload = {
  timestamp: new Date(),
  correlationId: 'wiring-audit',
} as unknown as BaseEvent;

/** Standard EventEmitterModule config matching production */
const eventEmitterImport = EventEmitterModule.forRoot({
  wildcard: true,
  delimiter: '.',
});

/** Simple mock provider — empty object (handlers are pre-spied with no-ops) */

function mock(token: any) {
  return { provide: token, useValue: {} };
}

/** ConfigService mock — returns the defaultValue arg (2nd param) like real ConfigService */
function mockConfigService() {
  return {
    provide: ConfigService,
    useValue: {
      get: vi
        .fn()
        .mockImplementation(
          (_key: string, defaultValue?: unknown) => defaultValue,
        ),
    },
  };
}

/**
 * Compile module, suppress onModuleInit on specified classes, init, then
 * pre-spy handler methods with no-op implementations so handler bodies
 * don't execute (preventing dependency errors from empty mocks).
 */
async function buildAndInit(
  moduleBuilder: ReturnType<typeof Test.createTestingModule>,
  initSuppressClasses: any[],
  handlerSpies: Array<{ cls: any; methods: string[] }>,
): Promise<TestingModule> {
  const module = await moduleBuilder.compile();

  // Suppress onModuleInit
  for (const cls of initSuppressClasses) {
    try {
      const inst = module.get(cls);
      if (typeof inst.onModuleInit === 'function') {
        vi.spyOn(inst, 'onModuleInit').mockResolvedValue(undefined);
      }
    } catch {
      /* not in module */
    }
  }

  await module.init();

  // Pre-spy handler methods with no-op to prevent dependency errors
  for (const { cls, methods } of handlerSpies) {
    const inst = module.get(cls);
    for (const method of methods) {
      vi.spyOn(inst, method as any).mockImplementation(() => {});
    }
  }

  return module;
}

// ──────────────────────────────────────────────────────────────
// AC2-INT-001: Non-Gateway @OnEvent Handlers
// ──────────────────────────────────────────────────────────────

describe('Event Wiring Audit — MatchAprUpdaterService', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await buildAndInit(
      Test.createTestingModule({
        imports: [eventEmitterImport],
        providers: [MatchAprUpdaterService, mock(PrismaService)],
      }),
      [],
      [
        {
          cls: MatchAprUpdaterService,
          methods: ['handleOpportunityIdentified', 'handleOpportunityFiltered'],
        },
      ],
    );
  });

  afterEach(async () => {
    await module.close();
  });

  it('[P0] handleOpportunityIdentified wired to OPPORTUNITY_IDENTIFIED', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
      payload: testPayload,
      handlerClass: MatchAprUpdaterService,
      handlerMethod: 'handleOpportunityIdentified',
    });
  });

  it('[P0] handleOpportunityFiltered wired to OPPORTUNITY_FILTERED', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.OPPORTUNITY_FILTERED,
      payload: testPayload,
      handlerClass: MatchAprUpdaterService,
      handlerMethod: 'handleOpportunityFiltered',
    });
  });
});

describe('Event Wiring Audit — CorrelationTrackerService', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await buildAndInit(
      Test.createTestingModule({
        imports: [eventEmitterImport],
        providers: [
          CorrelationTrackerService,
          mock(PrismaService),
          mockConfigService(),
        ],
      }),
      [],
      [
        {
          cls: CorrelationTrackerService,
          methods: ['onBudgetCommitted', 'onExitTriggered'],
        },
      ],
    );
  });

  afterEach(async () => {
    await module.close();
  });

  it('[P0] onBudgetCommitted wired to BUDGET_COMMITTED', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.BUDGET_COMMITTED,
      payload: testPayload,
      handlerClass: CorrelationTrackerService,
      handlerMethod: 'onBudgetCommitted',
    });
  });

  it('[P0] onExitTriggered wired to EXIT_TRIGGERED', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.EXIT_TRIGGERED,
      payload: testPayload,
      handlerClass: CorrelationTrackerService,
      handlerMethod: 'onExitTriggered',
    });
  });
});

describe('Event Wiring Audit — AutoUnwindService', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await buildAndInit(
      Test.createTestingModule({
        imports: [eventEmitterImport],
        providers: [
          AutoUnwindService,
          mockConfigService(),
          mock(PositionRepository),
          mock(OrderRepository),
          mock(KALSHI_CONNECTOR_TOKEN),
          mock(POLYMARKET_CONNECTOR_TOKEN),
          mock(SingleLegResolutionService),
        ],
      }),
      [],
      [{ cls: AutoUnwindService, methods: ['onSingleLegExposure'] }],
    );
  });

  afterEach(async () => {
    await module.close();
  });

  it('[P0] onSingleLegExposure wired to SINGLE_LEG_EXPOSURE', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      payload: testPayload,
      handlerClass: AutoUnwindService,
      handlerMethod: 'onSingleLegExposure',
    });
  });
});

describe('Event Wiring Audit — ExposureTrackerService', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await buildAndInit(
      Test.createTestingModule({
        imports: [eventEmitterImport],
        providers: [ExposureTrackerService, mock(PositionRepository)],
      }),
      [ExposureTrackerService],
      [{ cls: ExposureTrackerService, methods: ['onSingleLegExposure'] }],
    );
  });

  afterEach(async () => {
    await module.close();
  });

  it('[P0] onSingleLegExposure wired to SINGLE_LEG_EXPOSURE', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      payload: testPayload,
      handlerClass: ExposureTrackerService,
      handlerMethod: 'onSingleLegExposure',
    });
  });
});

describe('Event Wiring Audit — ShadowComparisonService', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await buildAndInit(
      Test.createTestingModule({
        imports: [eventEmitterImport],
        providers: [ShadowComparisonService],
      }),
      [],
      [
        {
          cls: ShadowComparisonService,
          methods: ['handleShadowComparison', 'handleExitTriggered'],
        },
      ],
    );
  });

  afterEach(async () => {
    await module.close();
  });

  it('[P0] handleShadowComparison wired to SHADOW_COMPARISON', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.SHADOW_COMPARISON,
      payload: testPayload,
      handlerClass: ShadowComparisonService,
      handlerMethod: 'handleShadowComparison',
    });
  });

  it('[P0] handleExitTriggered wired to EXIT_TRIGGERED', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.EXIT_TRIGGERED,
      payload: testPayload,
      handlerClass: ShadowComparisonService,
      handlerMethod: 'handleExitTriggered',
    });
  });
});

describe('Event Wiring Audit — DataIngestionService', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await buildAndInit(
      Test.createTestingModule({
        imports: [eventEmitterImport],
        providers: [
          DataIngestionService,
          mock(KalshiConnector),
          mock(PolymarketConnector),
          mock(PlatformHealthService),
          mock(DegradationProtocolService),
          mock(PrismaService),
          mock(ContractPairLoaderService),
          mockConfigService(),
          mock(PositionRepository),
          mock(DataDivergenceService),
        ],
      }),
      [DataIngestionService],
      [
        {
          cls: DataIngestionService,
          methods: [
            'handleOrderFilled',
            'handleExitTriggered',
            'handleSingleLegResolved',
          ],
        },
      ],
    );
  });

  afterEach(async () => {
    await module.close();
  });

  it('[P0] handleOrderFilled wired to ORDER_FILLED', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.ORDER_FILLED,
      payload: testPayload,
      handlerClass: DataIngestionService,
      handlerMethod: 'handleOrderFilled',
    });
  });

  it('[P0] handleExitTriggered wired to EXIT_TRIGGERED', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.EXIT_TRIGGERED,
      payload: testPayload,
      handlerClass: DataIngestionService,
      handlerMethod: 'handleExitTriggered',
    });
  });

  it('[P0] handleSingleLegResolved wired to SINGLE_LEG_RESOLVED', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.SINGLE_LEG_RESOLVED,
      payload: testPayload,
      handlerClass: DataIngestionService,
      handlerMethod: 'handleSingleLegResolved',
    });
  });
});

// ──────────────────────────────────────────────────────────────
// AC2-INT-002: System/Config @OnEvent Handlers
// ──────────────────────────────────────────────────────────────

describe('Event Wiring Audit — TradingEngineService', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await buildAndInit(
      Test.createTestingModule({
        imports: [eventEmitterImport],
        providers: [
          TradingEngineService,
          mock(DataIngestionService),
          mock(DetectionService),
          mock(EdgeCalculatorService),
          mock('IRiskManager'),
          mock(EXECUTION_QUEUE_TOKEN),
          mock(KALSHI_CONNECTOR_TOKEN),
          mock(POLYMARKET_CONNECTOR_TOKEN),
        ],
      }),
      [],
      [{ cls: TradingEngineService, methods: ['handleTimeHalt'] }],
    );
  });

  afterEach(async () => {
    await module.close();
  });

  it('[P0] handleTimeHalt wired to TIME_DRIFT_HALT', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.TIME_DRIFT_HALT,
      payload: testPayload,
      handlerClass: TradingEngineService,
      handlerMethod: 'handleTimeHalt',
    });
  });
});

describe('Event Wiring Audit — ConfigAccessor', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await buildAndInit(
      Test.createTestingModule({
        imports: [eventEmitterImport],
        providers: [
          ConfigAccessor,
          mock(EngineConfigRepository),
          mockConfigService(),
        ],
      }),
      [ConfigAccessor],
      [
        {
          cls: ConfigAccessor,
          methods: ['handleSettingsUpdated', 'handleBankrollUpdated'],
        },
      ],
    );
  });

  afterEach(async () => {
    await module.close();
  });

  it('[P0] handleSettingsUpdated wired to CONFIG_SETTINGS_UPDATED', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.CONFIG_SETTINGS_UPDATED,
      payload: testPayload,
      handlerClass: ConfigAccessor,
      handlerMethod: 'handleSettingsUpdated',
    });
  });

  it('[P0] handleBankrollUpdated wired to CONFIG_BANKROLL_UPDATED', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.CONFIG_BANKROLL_UPDATED,
      payload: testPayload,
      handlerClass: ConfigAccessor,
      handlerMethod: 'handleBankrollUpdated',
    });
  });
});

// ──────────────────────────────────────────────────────────────
// AC2-INT-003: DashboardGateway @OnEvent Handlers (22 subscriptions)
//
// Verifies @OnEvent decorator wiring only — NOT WebSocket broadcast.
// ──────────────────────────────────────────────────────────────

describe('Event Wiring Audit — DashboardGateway', () => {
  let module: TestingModule;

  const allGatewayMethods = [
    'broadcastHealthChange',
    'handleOrderFilled',
    'handleExecutionFailed',
    'handleSingleLegExposure',
    'handleLimitBreached',
    'handleLimitApproached',
    'handleExitTriggered',
    'handleBatchComplete',
    'handleMatchApproved',
    'handleMatchRejected',
    'handleClusterLimitBreached',
    'handleAggregateClusterLimitBreached',
    'handleBankrollUpdated',
    'handleDataDivergence',
    'handleTradingHalted',
    'handleTradingResumed',
    'handleShadowComparison',
    'handleShadowDailySummary',
    'handleAutoUnwind',
    'handleConfigSettingsUpdated',
  ];

  beforeEach(async () => {
    module = await buildAndInit(
      Test.createTestingModule({
        imports: [eventEmitterImport],
        providers: [
          DashboardGateway,
          mockConfigService(),
          mock(DashboardEventMapperService),
        ],
      }),
      [],
      [{ cls: DashboardGateway, methods: allGatewayMethods }],
    );
  });

  afterEach(async () => {
    await module.close();
  });

  // 3 stacked @OnEvent decorators → broadcastHealthChange
  it('[P1] broadcastHealthChange wired to PLATFORM_HEALTH_UPDATED', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.PLATFORM_HEALTH_UPDATED,
      payload: testPayload,
      handlerClass: DashboardGateway,
      handlerMethod: 'broadcastHealthChange',
    });
  });

  it('[P1] broadcastHealthChange wired to PLATFORM_HEALTH_DEGRADED', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.PLATFORM_HEALTH_DEGRADED,
      payload: testPayload,
      handlerClass: DashboardGateway,
      handlerMethod: 'broadcastHealthChange',
    });
  });

  it('[P1] broadcastHealthChange wired to PLATFORM_HEALTH_RECOVERED', async () => {
    await expectEventHandled({
      module,
      eventName: EVENT_NAMES.PLATFORM_HEALTH_RECOVERED,
      payload: testPayload,
      handlerClass: DashboardGateway,
      handlerMethod: 'broadcastHealthChange',
    });
  });

  // Individual gateway handlers (19 methods × 19 events)
  const gatewayHandlers = [
    { method: 'handleOrderFilled', event: EVENT_NAMES.ORDER_FILLED },
    { method: 'handleExecutionFailed', event: EVENT_NAMES.EXECUTION_FAILED },
    {
      method: 'handleSingleLegExposure',
      event: EVENT_NAMES.SINGLE_LEG_EXPOSURE,
    },
    { method: 'handleLimitBreached', event: EVENT_NAMES.LIMIT_BREACHED },
    { method: 'handleLimitApproached', event: EVENT_NAMES.LIMIT_APPROACHED },
    { method: 'handleExitTriggered', event: EVENT_NAMES.EXIT_TRIGGERED },
    { method: 'handleBatchComplete', event: EVENT_NAMES.BATCH_COMPLETE },
    { method: 'handleMatchApproved', event: EVENT_NAMES.MATCH_APPROVED },
    { method: 'handleMatchRejected', event: EVENT_NAMES.MATCH_REJECTED },
    {
      method: 'handleClusterLimitBreached',
      event: EVENT_NAMES.CLUSTER_LIMIT_BREACHED,
    },
    {
      method: 'handleAggregateClusterLimitBreached',
      event: EVENT_NAMES.AGGREGATE_CLUSTER_LIMIT_BREACHED,
    },
    {
      method: 'handleBankrollUpdated',
      event: EVENT_NAMES.CONFIG_BANKROLL_UPDATED,
    },
    { method: 'handleDataDivergence', event: EVENT_NAMES.DATA_DIVERGENCE },
    {
      method: 'handleTradingHalted',
      event: EVENT_NAMES.SYSTEM_TRADING_HALTED,
    },
    {
      method: 'handleTradingResumed',
      event: EVENT_NAMES.SYSTEM_TRADING_RESUMED,
    },
    {
      method: 'handleShadowComparison',
      event: EVENT_NAMES.SHADOW_COMPARISON,
    },
    {
      method: 'handleShadowDailySummary',
      event: EVENT_NAMES.SHADOW_DAILY_SUMMARY,
    },
    { method: 'handleAutoUnwind', event: EVENT_NAMES.AUTO_UNWIND },
    {
      method: 'handleConfigSettingsUpdated',
      event: EVENT_NAMES.CONFIG_SETTINGS_UPDATED,
    },
  ] as const;

  for (const { method, event } of gatewayHandlers) {
    it(`[P1] ${method} wired to ${event}`, async () => {
      await expectEventHandled({
        module,
        eventName: event,
        payload: testPayload,
        handlerClass: DashboardGateway,
        handlerMethod: method,
      });
    });
  }
});

// ──────────────────────────────────────────────────────────────
// AC2-INT-004: Dead Handler Detection
// ──────────────────────────────────────────────────────────────

describe('Event Wiring Audit — Dead Handler Detection (expectNoDeadHandlers on production classes)', () => {
  // Each test builds a module with the real service + EventEmitterModule,
  // then verifies all @OnEvent decorators reference events from EVENT_NAMES catalog.
  // A typo'd event name or orphaned decorator would fail here.

  const handlerClasses = [
    {
      name: 'MatchAprUpdaterService',
      cls: MatchAprUpdaterService,
      deps: [mock(PrismaService)],
    },
    {
      name: 'CorrelationTrackerService',
      cls: CorrelationTrackerService,
      deps: [mock(PrismaService), mockConfigService()],
    },
    {
      name: 'AutoUnwindService',
      cls: AutoUnwindService,
      deps: [
        mockConfigService(),
        mock(PositionRepository),
        mock(OrderRepository),
        mock(KALSHI_CONNECTOR_TOKEN),
        mock(POLYMARKET_CONNECTOR_TOKEN),
        mock(SingleLegResolutionService),
      ],
    },
    {
      name: 'ExposureTrackerService',
      cls: ExposureTrackerService,
      deps: [mock(PositionRepository)],
    },
    { name: 'ShadowComparisonService', cls: ShadowComparisonService, deps: [] },
    {
      name: 'DataIngestionService',
      cls: DataIngestionService,
      deps: [
        mock(KalshiConnector),
        mock(PolymarketConnector),
        mock(PlatformHealthService),
        mock(DegradationProtocolService),
        mock(PrismaService),
        mock(ContractPairLoaderService),
        mockConfigService(),
        mock(PositionRepository),
        mock(DataDivergenceService),
      ],
    },
    {
      name: 'TradingEngineService',
      cls: TradingEngineService,
      deps: [
        mock(DataIngestionService),
        mock(DetectionService),
        mock(EdgeCalculatorService),
        mock('IRiskManager'),
        mock(EXECUTION_QUEUE_TOKEN),
        mock(KALSHI_CONNECTOR_TOKEN),
        mock(POLYMARKET_CONNECTOR_TOKEN),
      ],
    },
    {
      name: 'ConfigAccessor',
      cls: ConfigAccessor,
      deps: [mock(EngineConfigRepository), mockConfigService()],
    },
    {
      name: 'DashboardGateway',
      cls: DashboardGateway,
      deps: [mockConfigService(), mock(DashboardEventMapperService)],
    },
  ];

  for (const { name, cls, deps } of handlerClasses) {
    it(`[P0] ${name} has no dead @OnEvent handlers`, async () => {
      const module = await buildAndInit(
        Test.createTestingModule({
          imports: [eventEmitterImport],
          providers: [cls, ...deps],
        }),
        [cls],
        [],
      );
      try {
        expectNoDeadHandlers(module, cls);
      } finally {
        await module.close();
      }
    });
  }
});
