import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SystemErrorFilter } from './system-error.filter.js';
import { SystemHealthError } from '../errors/system-health-error.js';
import { ExecutionError } from '../errors/execution-error.js';
import { EVENT_NAMES } from '../events/event-catalog.js';

// Suppress logger output
vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

function makeMockHost(type: string = 'http'): {
  host: ArgumentsHost;
  mockSend: ReturnType<typeof vi.fn>;
  mockStatus: ReturnType<typeof vi.fn>;
} {
  const mockSend = vi.fn();
  const mockStatus = vi.fn().mockReturnValue({ send: mockSend });
  const mockResponse = { status: mockStatus };

  const host = {
    getType: vi.fn().mockReturnValue(type),
    switchToHttp: vi.fn().mockReturnValue({
      getResponse: vi.fn().mockReturnValue(mockResponse),
      getRequest: vi.fn().mockReturnValue({}),
    }),
    switchToWs: vi.fn(),
    switchToRpc: vi.fn(),
    getArgs: vi.fn().mockReturnValue([]),
    getArgByIndex: vi.fn(),
  } as unknown as ArgumentsHost;

  return { host, mockSend, mockStatus };
}

describe('SystemErrorFilter', () => {
  let filter: SystemErrorFilter;
  let mockEmitter: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEmitter = { emit: vi.fn() };
    filter = new SystemErrorFilter(mockEmitter as unknown as EventEmitter2);
  });

  describe('HTTP context handling', () => {
    it('should return standard error response for SystemError', () => {
      const error = new SystemHealthError(
        4001,
        'Database pool exhausted',
        'critical',
        'database',
      );
      const { host, mockSend, mockStatus } = makeMockHost('http');

      filter.catch(error, host);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          error: {
            code: 4001,
            message: 'Database pool exhausted',
            severity: 'critical',
          },
          timestamp: expect.any(String) as unknown as string,
        }),
      );
    });

    it('should map critical severity to HTTP 500', () => {
      const error = new SystemHealthError(4001, 'Critical', 'critical');
      const { host, mockStatus } = makeMockHost('http');

      filter.catch(error, host);

      expect(mockStatus).toHaveBeenCalledWith(500);
    });

    it('should map warning severity to HTTP 400', () => {
      const error = new SystemHealthError(4002, 'Warning', 'warning');
      const { host, mockStatus } = makeMockHost('http');

      filter.catch(error, host);

      expect(mockStatus).toHaveBeenCalledWith(400);
    });

    it('should map error severity to HTTP 500', () => {
      const error = new ExecutionError(2001, 'Execution Error', 'error');
      const { host, mockStatus } = makeMockHost('http');

      filter.catch(error, host);

      expect(mockStatus).toHaveBeenCalledWith(500);
    });

    it('should include code, message, and severity in response body', () => {
      const error = new SystemHealthError(4003, 'Test message', 'warning');
      const { host, mockSend } = makeMockHost('http');

      filter.catch(error, host);

      const response = mockSend.mock.calls[0]![0] as {
        error: { code: number; message: string; severity: string };
        timestamp: string;
      };
      expect(response.error.code).toBe(4003);
      expect(response.error.message).toBe('Test message');
      expect(response.error.severity).toBe('warning');
      expect(response.timestamp).toBeDefined();
    });
  });

  describe('non-HTTP context handling', () => {
    it('should NOT call switchToHttp for ws context', () => {
      const error = new SystemHealthError(4001, 'WS error', 'critical');
      const { host } = makeMockHost('ws');

      filter.catch(error, host);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(host.switchToHttp).not.toHaveBeenCalled();
    });

    it('should NOT call switchToHttp for rpc context', () => {
      const error = new SystemHealthError(4001, 'RPC error', 'warning');
      const { host } = makeMockHost('rpc');

      filter.catch(error, host);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(host.switchToHttp).not.toHaveBeenCalled();
    });

    it('should still log and emit event for non-HTTP critical errors', () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error');
      const error = new SystemHealthError(
        4001,
        'Cron error',
        'critical',
        'scheduler',
      );
      const { host } = makeMockHost('rpc');

      filter.catch(error, host);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 4001,
          severity: 'critical',
        }),
      );
      expect(mockEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.SYSTEM_HEALTH_CRITICAL,
        expect.anything(),
      );
    });
  });

  describe('event emission for critical errors', () => {
    it('should emit SystemHealthCriticalEvent for critical severity', () => {
      const error = new SystemHealthError(
        4001,
        'Critical error',
        'critical',
        'database',
      );
      const { host } = makeMockHost('http');

      filter.catch(error, host);

      expect(mockEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.SYSTEM_HEALTH_CRITICAL,
        expect.objectContaining({
          component: 'database',
          severity: 'critical',
        }),
      );
    });

    it('should NOT emit event for warning severity', () => {
      const error = new SystemHealthError(4002, 'Warning error', 'warning');
      const { host } = makeMockHost('http');

      filter.catch(error, host);

      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    it('should NOT emit event for error severity', () => {
      const error = new ExecutionError(2001, 'Execution error', 'error');
      const { host } = makeMockHost('http');

      filter.catch(error, host);

      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('re-entrancy guard', () => {
    it('should prevent circular event emission', () => {
      // Simulate: first catch → emit → triggers second catch → should NOT emit again
      let emitCallCount = 0;
      mockEmitter.emit.mockImplementation(() => {
        emitCallCount++;
        if (emitCallCount === 1) {
          // Simulate the event handler failing and another SystemError being caught by the filter
          const nestedError = new SystemHealthError(4099, 'Nested', 'critical');
          const { host: nestedHost } = makeMockHost('http');
          filter.catch(nestedError, nestedHost);
        }
      });

      const error = new SystemHealthError(4001, 'Original', 'critical');
      const { host } = makeMockHost('http');

      filter.catch(error, host);

      // emit should only be called once (for the outer error), not for the nested one
      expect(emitCallCount).toBe(1);
    });
  });

  describe('structured logging', () => {
    it('should log error with full context', () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error');
      const error = new SystemHealthError(
        4001,
        'Pool exhausted',
        'critical',
        'database',
        {
          maxRetries: 3,
          initialDelayMs: 1000,
          maxDelayMs: 5000,
          backoffMultiplier: 2,
        },
      );
      const { host } = makeMockHost('http');

      filter.catch(error, host);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Pool exhausted',
          code: 4001,
          severity: 'critical',
          component: 'database',
          module: 'system-error-filter',
        }),
      );
    });
  });
});
