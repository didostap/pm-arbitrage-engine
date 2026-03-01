import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'http';
import { DashboardGateway } from './dashboard.gateway';
import { DashboardEventMapperService } from './dashboard-event-mapper.service';
import type { PlatformHealth } from '../common/types/platform.type';
import { PlatformId } from '../common/types/platform.type';

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

    mapper = new DashboardEventMapperService();
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
});
