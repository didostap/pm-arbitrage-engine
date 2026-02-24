import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ComplianceValidatorService } from './compliance-validator.service';
import { ComplianceConfigLoaderService } from './compliance-config-loader.service';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import { ComplianceBlockedEvent } from '../../../common/events/execution.events';
import type {
  ComplianceCheckContext,
  ComplianceMatrixConfig,
} from './compliance-config';

function makeConfig(
  overrides?: Partial<ComplianceMatrixConfig>,
): ComplianceMatrixConfig {
  return {
    defaultAction: 'allow',
    rules: [
      {
        platform: 'KALSHI',
        blockedCategories: ['adult-content', 'assassination', 'terrorism'],
      },
      {
        platform: 'POLYMARKET',
        blockedCategories: ['adult-content', 'assassination', 'terrorism'],
      },
    ],
    ...overrides,
  };
}

function makeContext(
  overrides?: Partial<ComplianceCheckContext>,
): ComplianceCheckContext {
  return {
    pairId: 'pair-1',
    opportunityId: 'opp-1',
    primaryPlatform: 'KALSHI',
    secondaryPlatform: 'POLYMARKET',
    eventDescription: 'Will BTC hit $100k by June 2026?',
    kalshiContractId: 'kalshi-1',
    polymarketContractId: 'poly-1',
    ...overrides,
  };
}

describe('ComplianceValidatorService', () => {
  let service: ComplianceValidatorService;
  let configLoader: { getConfig: ReturnType<typeof vi.fn> };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    configLoader = { getConfig: vi.fn().mockReturnValue(makeConfig()) };
    eventEmitter = { emit: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ComplianceValidatorService,
        { provide: ComplianceConfigLoaderService, useValue: configLoader },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get(ComplianceValidatorService);
  });

  it('should approve trade when no violations found', () => {
    const result = service.validate(makeContext());

    expect(result.approved).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('should block trade when eventDescription matches blocked category on primary platform', () => {
    const result = service.validate(
      makeContext({
        eventDescription:
          'Will there be an assassination attempt on the president?',
      }),
    );

    expect(result.approved).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations[0].platform).toBe('KALSHI');
    expect(result.violations[0].category).toBe('assassination');
  });

  it('should block trade when eventDescription matches blocked category on secondary platform', () => {
    // Use a config where only POLYMARKET blocks "crypto-ban"
    configLoader.getConfig.mockReturnValue(
      makeConfig({
        rules: [
          { platform: 'KALSHI', blockedCategories: ['adult-content'] },
          { platform: 'POLYMARKET', blockedCategories: ['crypto-ban'] },
        ],
      }),
    );

    const result = service.validate(
      makeContext({
        eventDescription: 'Will there be a crypto-ban in Europe?',
      }),
    );

    expect(result.approved).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].platform).toBe('POLYMARKET');
  });

  it('should block trade when both platforms have violations', () => {
    const result = service.validate(
      makeContext({
        eventDescription: 'Terrorism-related assassination event',
      }),
    );

    expect(result.approved).toBe(false);
    // Both platforms block "assassination" and "terrorism" — 2 categories × 2 platforms = 4
    expect(result.violations.length).toBe(4);
  });

  it('should perform case-insensitive matching', () => {
    const result = service.validate(
      makeContext({ eventDescription: 'ASSASSINATION ATTEMPT on leader' }),
    );

    expect(result.approved).toBe(false);
    expect(result.violations.some((v) => v.category === 'assassination')).toBe(
      true,
    );
  });

  it('should perform partial match (substring)', () => {
    const result = service.validate(
      makeContext({
        eventDescription: 'Will there be an assassination attempt by 2027?',
      }),
    );

    expect(result.approved).toBe(false);
    expect(result.violations[0].rule).toBe('Blocked category: assassination');
  });

  it('should emit COMPLIANCE_BLOCKED event with full violation context', () => {
    service.validate(
      makeContext({ eventDescription: 'Assassination contract' }),
      true,
      false,
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.COMPLIANCE_BLOCKED,
      expect.any(ComplianceBlockedEvent),
    );

    const emittedEvent = eventEmitter.emit.mock
      .calls[0][1] as ComplianceBlockedEvent;
    expect(emittedEvent.opportunityId).toBe('opp-1');
    expect(emittedEvent.pairId).toBe('pair-1');
    expect(emittedEvent.violations.length).toBeGreaterThan(0);
    expect(emittedEvent.isPaper).toBe(true);
    expect(emittedEvent.mixedMode).toBe(false);
  });

  it('should not emit event when trade is approved', () => {
    service.validate(makeContext());

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('should approve all trades with empty blocked categories config', () => {
    configLoader.getConfig.mockReturnValue(
      makeConfig({
        rules: [
          {
            platform: 'KALSHI',
            blockedCategories: ['niche-category-nobody-uses'],
          },
          { platform: 'POLYMARKET', blockedCategories: ['another-niche'] },
        ],
      }),
    );

    const result = service.validate(
      makeContext({ eventDescription: 'Will BTC hit $100k?' }),
    );

    expect(result.approved).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('should store violation timestamps as ISO strings', () => {
    const result = service.validate(
      makeContext({ eventDescription: 'Assassination contract' }),
    );

    expect(result.violations.length).toBeGreaterThan(0);
    // Verify timestamp is an ISO string, not a Date object
    expect(typeof result.violations[0].timestamp).toBe('string');
    expect(() => new Date(result.violations[0].timestamp)).not.toThrow();
  });

  it('should block when defaultAction is deny and platform has no rule', () => {
    configLoader.getConfig.mockReturnValue(
      makeConfig({
        defaultAction: 'deny',
        rules: [
          { platform: 'KALSHI', blockedCategories: ['adult-content'] },
          // No POLYMARKET rule
        ],
      }),
    );

    const result = service.validate(
      makeContext({ eventDescription: 'Will BTC hit $100k?' }),
    );

    expect(result.approved).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].platform).toBe('POLYMARKET');
    expect(result.violations[0].category).toBe('*');
    expect(result.violations[0].rule).toContain('Default deny');
  });

  it('should allow when defaultAction is allow and platform has no rule', () => {
    configLoader.getConfig.mockReturnValue(
      makeConfig({
        defaultAction: 'allow',
        rules: [
          { platform: 'KALSHI', blockedCategories: ['adult-content'] },
          // No POLYMARKET rule
        ],
      }),
    );

    const result = service.validate(
      makeContext({ eventDescription: 'Will BTC hit $100k?' }),
    );

    expect(result.approved).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});
