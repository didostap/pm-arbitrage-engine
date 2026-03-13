/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditLogRetentionService } from './audit-log-retention.service.js';
import { AuditLogRepository } from '../../persistence/repositories/audit-log.repository.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import { AuditLogPrunedEvent } from '../../common/events/monitoring.events.js';
import { MONITORING_ERROR_CODES } from './monitoring-error-codes.js';
import { withCorrelationId } from '../../common/services/correlation-context.js';

vi.mock('../../common/services/correlation-context.js', () => ({
  withCorrelationId: vi.fn((fn: () => Promise<void>) => fn()),
}));

// Suppress logger output
vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

describe('AuditLogRetentionService', () => {
  let service: AuditLogRetentionService;
  let mockConfig: { get: ReturnType<typeof vi.fn> };
  let mockRepo: { deleteOlderThan: ReturnType<typeof vi.fn> };
  let mockEmitter: { emit: ReturnType<typeof vi.fn> };
  let loggerDebugSpy: ReturnType<typeof vi.spyOn>;
  let loggerErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(withCorrelationId).mockClear();
    mockConfig = {
      get: vi.fn().mockReturnValue(7),
    };
    mockRepo = {
      deleteOlderThan: vi.fn().mockResolvedValue(42),
    };
    mockEmitter = {
      emit: vi.fn(),
    };

    service = new AuditLogRetentionService(
      mockConfig as unknown as ConfigService,
      mockRepo as unknown as AuditLogRepository,
      mockEmitter as unknown as EventEmitter2,
    );

    loggerDebugSpy = vi.spyOn(Logger.prototype, 'debug');
    loggerErrorSpy = vi.spyOn(Logger.prototype, 'error');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should prune rows older than retention window and emit event', async () => {
    vi.useFakeTimers({ now: new Date('2026-03-13T03:00:00Z') });

    await service.handlePruning();

    const expectedCutoff = new Date('2026-03-06T03:00:00Z');
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledWith(expectedCutoff);
    expect(mockEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.AUDIT_LOG_PRUNED,
      expect.any(AuditLogPrunedEvent),
    );

    const emittedEvent = mockEmitter.emit.mock
      .calls[0]![1] as AuditLogPrunedEvent;
    expect(emittedEvent.prunedCount).toBe(42);
    expect(emittedEvent.cutoffDate).toBe(expectedCutoff.toISOString());
    expect(emittedEvent.retentionDays).toBe(7);
  });

  it('should skip pruning when AUDIT_LOG_RETENTION_DAYS=0', async () => {
    mockConfig.get.mockReturnValue(0);

    await service.handlePruning();

    expect(mockRepo.deleteOlderThan).not.toHaveBeenCalled();
    expect(mockEmitter.emit).not.toHaveBeenCalled();
    expect(loggerDebugSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('disabled'),
      }),
    );
  });

  it('should not emit event when 0 rows pruned', async () => {
    mockRepo.deleteOlderThan.mockResolvedValue(0);

    await service.handlePruning();

    expect(mockRepo.deleteOlderThan).toHaveBeenCalled();
    expect(mockEmitter.emit).not.toHaveBeenCalled();
    expect(loggerDebugSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('No audit log rows'),
      }),
    );
  });

  it('should handle repository error gracefully without throwing', async () => {
    mockRepo.deleteOlderThan.mockRejectedValue(new Error('DB connection lost'));

    await expect(service.handlePruning()).resolves.toBeUndefined();

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Audit log pruning failed',
        code: MONITORING_ERROR_CODES.AUDIT_LOG_PRUNE_FAILED,
      }),
    );
    expect(mockEmitter.emit).not.toHaveBeenCalled();
  });

  it('should calculate correct cutoff date from config value', async () => {
    vi.useFakeTimers({ now: new Date('2026-03-13T03:00:00Z') });
    mockConfig.get.mockReturnValue(14);

    await service.handlePruning();

    const expectedCutoff = new Date('2026-02-27T03:00:00Z');
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledWith(expectedCutoff);
  });

  it('should use withCorrelationId wrapper', async () => {
    await service.handlePruning();

    expect(withCorrelationId).toHaveBeenCalledOnce();
    expect(withCorrelationId).toHaveBeenCalledWith(expect.any(Function));
  });
});
