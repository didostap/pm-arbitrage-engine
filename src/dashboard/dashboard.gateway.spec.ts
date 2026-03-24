import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'http';
import { DashboardGateway } from './dashboard.gateway';
import { DashboardEventMapperService } from './dashboard-event-mapper.service';
import type { PlatformHealth } from '../common/types/platform.type';
import { PlatformId } from '../common/types/platform.type';
import { BatchCompleteEvent } from '../common/events/batch.events';
import {
  TradingHaltedEvent,
  TradingResumedEvent,
} from '../common/events/system.events';
import { ShadowComparisonEvent } from '../common/events/execution.events';

vi.mock('../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

function createMockWsClient(): {
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  readyState: number;
} {
  return {
    close: vi.fn(),
    send: vi.fn(),
    readyState: 1, // WebSocket.OPEN
  };
}

function createMockRequest(token?: string): IncomingMessage {
  const url = token ? `/ws?token=${token}` : '/ws';
  return { url } as IncomingMessage;
}

describe('DashboardGateway', () => {
  let gateway: DashboardGateway;
  let configService: ConfigService;
  let mapper: DashboardEventMapperService;

  beforeEach(() => {
    configService = {
      get: vi.fn((key: string) => {
        if (key === 'OPERATOR_API_TOKEN') return 'test-token';
        return undefined;
      }),
    } as unknown as ConfigService;

    mapper = new DashboardEventMapperService(configService);
    gateway = new DashboardGateway(configService, mapper);
  });

  describe('handleConnection', () => {
    it('should accept client with valid token', () => {
      const client = createMockWsClient();
      const request = createMockRequest('test-token');

      gateway.handleConnection(client as never, request);

      expect(client.close).not.toHaveBeenCalled();
      expect(gateway.getConnectedClientCount()).toBe(1);
    });

    it('should reject client with invalid token (close 4001)', () => {
      const client = createMockWsClient();
      const request = createMockRequest('wrong-token');

      gateway.handleConnection(client as never, request);

      expect(client.close).toHaveBeenCalledWith(4001, 'Unauthorized');
      expect(gateway.getConnectedClientCount()).toBe(0);
    });

    it('should reject client with missing token', () => {
      const client = createMockWsClient();
      const request = createMockRequest();

      gateway.handleConnection(client as never, request);

      expect(client.close).toHaveBeenCalledWith(4001, 'Unauthorized');
    });

    it('should reject client with empty token', () => {
      const client = createMockWsClient();
      const request = createMockRequest('');

      gateway.handleConnection(client as never, request);

      expect(client.close).toHaveBeenCalledWith(4001, 'Unauthorized');
    });
  });

  describe('handleDisconnect', () => {
    it('should remove client from connected set', () => {
      const client = createMockWsClient();
      const request = createMockRequest('test-token');
      gateway.handleConnection(client as never, request);
      expect(gateway.getConnectedClientCount()).toBe(1);

      gateway.handleDisconnect(client as never);
      expect(gateway.getConnectedClientCount()).toBe(0);
    });
  });

  describe('broadcast', () => {
    it('should send event to all connected clients', () => {
      const client1 = createMockWsClient();
      const client2 = createMockWsClient();
      const request = createMockRequest('test-token');
      gateway.handleConnection(client1 as never, request);
      gateway.handleConnection(client2 as never, request);

      const health: PlatformHealth = {
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'live',
      };

      gateway.broadcastHealthChange(health);

      expect(client1.send).toHaveBeenCalledTimes(1);
      expect(client2.send).toHaveBeenCalledTimes(1);

      const sent = JSON.parse(client1.send.mock.calls[0]![0] as string) as {
        event: string;
        data: { platformId: string };
      };
      expect(sent.event).toBe('health.change');
      expect(sent.data.platformId).toBe('kalshi');
    });

    it('should skip clients that are not open', () => {
      const client = createMockWsClient();
      const request = createMockRequest('test-token');
      gateway.handleConnection(client as never, request);

      client.readyState = 3; // WebSocket.CLOSED

      const health: PlatformHealth = {
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'live',
      };
      gateway.broadcastHealthChange(health);

      expect(client.send).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('should clear all connected clients', () => {
      const client = createMockWsClient();
      const request = createMockRequest('test-token');
      gateway.handleConnection(client as never, request);
      expect(gateway.getConnectedClientCount()).toBe(1);

      gateway.onModuleDestroy();
      expect(gateway.getConnectedClientCount()).toBe(0);
    });
  });

  describe('handleBatchComplete', () => {
    it('should broadcast batch.complete event to connected clients', () => {
      const client = createMockWsClient();
      const request = createMockRequest('test-token');
      gateway.handleConnection(client as never, request);

      const event = new BatchCompleteEvent('batch-123', [
        {
          positionId: 'pos-1',
          pairName: 'BTC > 50k',
          status: 'success',
          realizedPnl: '0.01500000',
        },
      ]);

      gateway.handleBatchComplete(event);

      expect(client.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(client.send.mock.calls[0]![0] as string) as {
        event: string;
        data: { batchId: string; results: unknown[] };
      };
      expect(sent.event).toBe('batch.complete');
      expect(sent.data.batchId).toBe('batch-123');
      expect(sent.data.results).toHaveLength(1);
    });
  });

  describe('trading halt events', () => {
    it('should broadcast all active reasons from event details', () => {
      const client = createMockWsClient();
      gateway.handleConnection(
        client as never,
        createMockRequest('test-token') as never,
      );

      const event = new TradingHaltedEvent(
        'reconciliation_discrepancy',
        { activeReasons: ['daily_loss_limit', 'reconciliation_discrepancy'] },
        new Date('2026-03-16T12:00:00Z'),
        'critical',
      );
      gateway.handleTradingHalted(event);

      expect(client.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(client.send.mock.calls[0]![0] as string) as {
        event: string;
        data: { halted: boolean; reasons: string[] };
      };
      expect(sent.event).toBe('trading.halt');
      expect(sent.data.halted).toBe(true);
      expect(sent.data.reasons).toEqual([
        'daily_loss_limit',
        'reconciliation_discrepancy',
      ]);
    });

    it('should fall back to single reason when details lacks activeReasons', () => {
      const client = createMockWsClient();
      gateway.handleConnection(
        client as never,
        createMockRequest('test-token') as never,
      );

      // time_drift event passes a number as details, not an object with activeReasons
      const event = new TradingHaltedEvent(
        'time_drift',
        1500,
        new Date('2026-03-16T12:00:00Z'),
        'critical',
      );
      gateway.handleTradingHalted(event);

      const sent = JSON.parse(client.send.mock.calls[0]![0] as string) as {
        event: string;
        data: { halted: boolean; reasons: string[] };
      };
      expect(sent.data.reasons).toEqual(['time_drift']);
    });

    it('should broadcast resumed state on TradingResumedEvent', () => {
      const client = createMockWsClient();
      gateway.handleConnection(
        client as never,
        createMockRequest('test-token') as never,
      );

      const event = new TradingResumedEvent(
        'daily_loss_limit',
        [],
        new Date('2026-03-16T12:00:00Z'),
      );
      gateway.handleTradingResumed(event);

      expect(client.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(client.send.mock.calls[0]![0] as string) as {
        event: string;
        data: { halted: boolean; reasons: string[] };
      };
      expect(sent.event).toBe('trading.halt');
      expect(sent.data.halted).toBe(false);
      expect(sent.data.reasons).toEqual([]);
    });
  });

  describe('handleShadowComparison (Story 10.7.7)', () => {
    it('should broadcast new decision fields with correct values', () => {
      const client = createMockWsClient();
      const request = createMockRequest('test-token');
      gateway.handleConnection(client as never, request);

      const event = new ShadowComparisonEvent(
        'pos-1' as never,
        'pair-1' as never,
        { triggered: true, type: 'stop_loss', currentPnl: '-0.05000000' },
        {
          triggered: false,
          currentPnl: '-0.03000000',
          criteria: [
            {
              criterion: 'edge_evaporation',
              proximity: '0.75',
              triggered: false,
            },
          ],
        },
        new Date('2026-03-24T12:00:00Z'),
        'exit:stop_loss',
        'hold',
        false,
        '0.01500000',
        {
          triggeredCriteria: [],
          proximityValues: { edge_evaporation: '0.75000000' },
          fixedType: 'stop_loss',
          modelType: null,
        },
      );

      gateway.handleShadowComparison(event);

      expect(client.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(client.send.mock.calls[0]![0] as string) as {
        event: string;
        data: Record<string, unknown>;
      };
      expect(sent.event).toBe('shadow.comparison');
      expect(sent.data).toEqual(
        expect.objectContaining({
          shadowDecision: 'exit:stop_loss',
          modelDecision: 'hold',
          agreement: false,
          currentEdge: '0.01500000',
        }),
      );
    });
  });
});
