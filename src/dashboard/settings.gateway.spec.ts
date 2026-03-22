import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'http';
import { DashboardGateway } from './dashboard.gateway.js';
import { DashboardEventMapperService } from './dashboard-event-mapper.service.js';
import { ConfigSettingsUpdatedEvent } from '../common/events/config.events.js';

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

describe('DashboardGateway — ConfigSettingsUpdated broadcast', () => {
  let gateway: DashboardGateway;
  let configService: ConfigService;

  beforeEach(() => {
    configService = {
      get: vi.fn((key: string) => {
        if (key === 'OPERATOR_API_TOKEN') return 'test-token';
        return undefined;
      }),
    } as unknown as ConfigService;

    const mapper = new DashboardEventMapperService(configService);
    gateway = new DashboardGateway(configService, mapper);
  });

  it('[P1] ConfigSettingsUpdatedEvent triggers WS broadcast with event "config.settings.updated"', () => {
    const client = createMockWsClient();
    gateway.handleConnection(client as never, createMockRequest('test-token'));

    const event = new ConfigSettingsUpdatedEvent(
      { riskMaxPositionPct: { previous: '0.03', current: '0.05' } },
      'operator',
    );
    gateway.handleConfigSettingsUpdated(event);

    expect(client.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(client.send.mock.calls[0]![0] as string) as {
      event: string;
      data: unknown;
      timestamp: string;
    };
    expect(sent.event).toBe('config.settings.updated');
  });

  it('[P1] WS payload contains only changed fields with new values (NOT full config)', () => {
    const client = createMockWsClient();
    gateway.handleConnection(client as never, createMockRequest('test-token'));

    const event = new ConfigSettingsUpdatedEvent(
      {
        riskMaxPositionPct: { previous: '0.03', current: '0.05' },
        riskMaxOpenPairs: { previous: 10, current: 15 },
      },
      'operator',
    );
    gateway.handleConfigSettingsUpdated(event);

    expect(client.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(client.send.mock.calls[0]![0] as string) as {
      event: string;
      data: {
        changedFields: string[];
        newValues: Record<string, unknown>;
        updatedBy: string;
      };
    };
    expect(sent.data.changedFields).toEqual([
      'riskMaxPositionPct',
      'riskMaxOpenPairs',
    ]);
    expect(sent.data.newValues).toEqual({
      riskMaxPositionPct: '0.05',
      riskMaxOpenPairs: 15,
    });
    expect(sent.data).not.toHaveProperty('risk');
    expect(sent.data).not.toHaveProperty('execution');
  });

  it('[P2] WS payload includes updatedBy and timestamp', () => {
    const client = createMockWsClient();
    gateway.handleConnection(client as never, createMockRequest('test-token'));

    const event = new ConfigSettingsUpdatedEvent(
      { pollingIntervalMs: { previous: 30000, current: 15000 } },
      'operator',
    );
    gateway.handleConfigSettingsUpdated(event);

    expect(client.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(client.send.mock.calls[0]![0] as string) as {
      event: string;
      data: { updatedBy: string };
      timestamp: string;
    };
    expect(sent.data.updatedBy).toBe('operator');
    expect(sent.timestamp).toBeDefined();
    expect(typeof sent.timestamp).toBe('string');
  });
});
