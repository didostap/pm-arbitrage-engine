/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { AuditLogService } from './audit-log.service.js';
import { AuditLogRepository } from '../../persistence/repositories/audit-log.repository.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';

// Suppress logger output
vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

const GENESIS_HASH = '0'.repeat(64);

function createMockRepo() {
  return {
    create: vi
      .fn()
      .mockImplementation((data) =>
        Promise.resolve({ id: 'audit-1', createdAt: new Date(), ...data }),
      ),
    findLast: vi.fn().mockResolvedValue(null),
    findByDateRange: vi.fn().mockResolvedValue([]),
    findJustBefore: vi.fn().mockResolvedValue(null),
  };
}

describe('AuditLogService', () => {
  let service: AuditLogService;
  let mockRepo: ReturnType<typeof createMockRepo>;
  let mockEmitter: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockRepo = createMockRepo();
    mockEmitter = { emit: vi.fn() };

    service = new AuditLogService(
      mockRepo as unknown as AuditLogRepository,
      mockEmitter as unknown as EventEmitter2,
    );
  });

  describe('hash chain logic', () => {
    it('should use genesis hash for first entry', async () => {
      await service.append({
        eventType: 'execution.order.filled',
        module: 'execution',
        details: { orderId: 'order-1' },
      });

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          previousHash: GENESIS_HASH,
        }),
      );
    });

    it('should chain subsequent entries correctly', async () => {
      await service.append({
        eventType: 'execution.order.filled',
        module: 'execution',
        details: { orderId: 'order-1' },
      });

      const firstCall = mockRepo.create.mock.calls[0]![0] as {
        currentHash: string;
      };
      const firstHash = firstCall.currentHash;

      await service.append({
        eventType: 'risk.limit.breached',
        module: 'risk',
        details: { limit: 'daily_loss' },
      });

      expect(mockRepo.create).toHaveBeenCalledTimes(2);
      const secondCall = mockRepo.create.mock.calls[1]![0] as {
        previousHash: string;
      };
      expect(secondCall.previousHash).toBe(firstHash);
    });

    it('should produce deterministic hashes for same inputs', async () => {
      const entry = {
        eventType: 'execution.order.filled',
        module: 'execution',
        details: { orderId: 'order-1', amount: 100 },
      };

      await service.append(entry);
      const hash1 = (
        mockRepo.create.mock.calls[0]![0] as { currentHash: string }
      ).currentHash;

      // Reset for fresh service
      const mockRepo2 = createMockRepo();
      const service2 = new AuditLogService(
        mockRepo2 as unknown as AuditLogRepository,
        mockEmitter as unknown as EventEmitter2,
      );

      await service2.append(entry);
      const hash2 = (
        mockRepo2.create.mock.calls[0]![0] as { currentHash: string }
      ).currentHash;

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different inputs', async () => {
      await service.append({
        eventType: 'execution.order.filled',
        module: 'execution',
        details: { orderId: 'order-1' },
      });

      const hash1 = (
        mockRepo.create.mock.calls[0]![0] as { currentHash: string }
      ).currentHash;

      // Reset
      const mockRepo2 = createMockRepo();
      const service2 = new AuditLogService(
        mockRepo2 as unknown as AuditLogRepository,
        mockEmitter as unknown as EventEmitter2,
      );

      await service2.append({
        eventType: 'execution.order.filled',
        module: 'execution',
        details: { orderId: 'order-2' },
      });

      const hash2 = (
        mockRepo2.create.mock.calls[0]![0] as { currentHash: string }
      ).currentHash;

      expect(hash1).not.toBe(hash2);
    });

    it('should produce deterministic hash regardless of key insertion order', async () => {
      await service.append({
        eventType: 'test',
        module: 'test',
        details: { a: 1, b: 2, c: 3 },
      });

      const hash1 = (
        mockRepo.create.mock.calls[0]![0] as { currentHash: string }
      ).currentHash;

      const mockRepo2 = createMockRepo();
      const service2 = new AuditLogService(
        mockRepo2 as unknown as AuditLogRepository,
        mockEmitter as unknown as EventEmitter2,
      );

      await service2.append({
        eventType: 'test',
        module: 'test',
        details: { c: 3, a: 1, b: 2 },
      });

      const hash2 = (
        mockRepo2.create.mock.calls[0]![0] as { currentHash: string }
      ).currentHash;

      expect(hash1).toBe(hash2);
    });
  });

  describe('write serialization', () => {
    it('should serialize concurrent append calls', async () => {
      const callOrder: number[] = [];
      let callCount = 0;

      mockRepo.create.mockImplementation(() => {
        const idx = callCount++;
        callOrder.push(idx);
        return Promise.resolve({
          id: `audit-${idx}`,
          createdAt: new Date(),
          eventType: 'test',
          module: 'test',
          details: {},
          previousHash: '0'.repeat(64),
          currentHash: 'a'.repeat(64),
        });
      });

      // Fire 3 concurrent appends
      const p1 = service.append({
        eventType: 'event-1',
        module: 'test',
        details: { idx: 1 },
      });
      const p2 = service.append({
        eventType: 'event-2',
        module: 'test',
        details: { idx: 2 },
      });
      const p3 = service.append({
        eventType: 'event-3',
        module: 'test',
        details: { idx: 3 },
      });

      await Promise.all([p1, p2, p3]);

      // All 3 should have been called in sequence
      expect(mockRepo.create).toHaveBeenCalledTimes(3);
      expect(callOrder).toEqual([0, 1, 2]);

      // Each entry's previousHash should be the previous entry's currentHash
      const calls = mockRepo.create.mock.calls as Array<
        [{ previousHash: string; currentHash: string }]
      >;
      expect(calls[0]![0].previousHash).toBe(GENESIS_HASH);
      expect(calls[1]![0].previousHash).toBe(calls[0]![0].currentHash);
      expect(calls[2]![0].previousHash).toBe(calls[1]![0].currentHash);
    });
  });

  describe('onModuleInit', () => {
    it('should load last hash from DB on init', async () => {
      mockRepo.findLast.mockResolvedValue({
        id: 'audit-existing',
        currentHash: 'b'.repeat(64),
      });

      await service.onModuleInit();

      // Now append should use the loaded hash as previousHash
      await service.append({
        eventType: 'test',
        module: 'test',
        details: {},
      });

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          previousHash: 'b'.repeat(64),
        }),
      );
    });
  });

  describe('error handling', () => {
    it('should emit AUDIT_LOG_FAILED event on write failure', async () => {
      mockRepo.create.mockRejectedValue(new Error('DB write failed'));

      await expect(
        service.append({
          eventType: 'test',
          module: 'test',
          details: {},
        }),
      ).rejects.toThrow('DB write failed');

      expect(mockEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUDIT_LOG_FAILED,
        expect.objectContaining({
          error: expect.stringContaining('DB write failed'),
          eventType: 'test',
          module: 'test',
        }),
      );
    });

    it('should not break serialization queue after write failure', async () => {
      mockRepo.create
        .mockRejectedValueOnce(new Error('DB write failed'))
        .mockImplementation((data) =>
          Promise.resolve({ id: 'audit-2', createdAt: new Date(), ...data }),
        );

      // First call fails
      await expect(
        service.append({
          eventType: 'event-1',
          module: 'test',
          details: {},
        }),
      ).rejects.toThrow();

      // Second call should still work
      await service.append({
        eventType: 'event-2',
        module: 'test',
        details: {},
      });

      expect(mockRepo.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('verifyChain', () => {
    it('should return valid for intact chain', async () => {
      // Build a real chain using the service
      await service.append({
        eventType: 'event-1',
        module: 'test',
        details: { a: 1 },
      });
      await service.append({
        eventType: 'event-2',
        module: 'test',
        details: { b: 2 },
      });

      const entries = mockRepo.create.mock.calls.map(
        (call: unknown[], idx: number) => ({
          ...(call[0] as Record<string, unknown>),
          id: `audit-${idx}`,
        }),
      );

      mockRepo.findByDateRange.mockResolvedValue(entries);
      mockRepo.findJustBefore.mockResolvedValue(null);

      const result = await service.verifyChain(
        new Date('2026-01-15'),
        new Date('2026-01-16'),
      );

      expect(result.valid).toBe(true);
      expect(result.entriesChecked).toBe(2);
    });

    it('should detect tampered entry', async () => {
      await service.append({
        eventType: 'event-1',
        module: 'test',
        details: { a: 1 },
      });
      await service.append({
        eventType: 'event-2',
        module: 'test',
        details: { b: 2 },
      });

      const entries = mockRepo.create.mock.calls.map(
        (call: unknown[], idx: number) => ({
          ...(call[0] as Record<string, unknown>),
          id: `audit-${idx}`,
        }),
      );

      // Tamper with second entry's details
      (entries[1] as Record<string, unknown>).details = { b: 999 };

      mockRepo.findByDateRange.mockResolvedValue(entries);
      mockRepo.findJustBefore.mockResolvedValue(null);

      const result = await service.verifyChain(
        new Date('2026-01-15'),
        new Date('2026-01-16'),
      );

      expect(result.valid).toBe(false);
      expect(result.brokenAtId).toBe('audit-1');
    });

    it('should return valid with zero entries for empty date range', async () => {
      mockRepo.findByDateRange.mockResolvedValue([]);

      const result = await service.verifyChain(
        new Date('2099-01-01'),
        new Date('2099-01-02'),
      );

      expect(result.valid).toBe(true);
      expect(result.entriesChecked).toBe(0);
    });

    it('should detect missing entry (gap in chain)', async () => {
      await service.append({
        eventType: 'event-1',
        module: 'test',
        details: { a: 1 },
      });
      await service.append({
        eventType: 'event-2',
        module: 'test',
        details: { b: 2 },
      });
      await service.append({
        eventType: 'event-3',
        module: 'test',
        details: { c: 3 },
      });

      const allEntries = mockRepo.create.mock.calls.map(
        (call: unknown[], idx: number) => ({
          ...(call[0] as Record<string, unknown>),
          id: `audit-${idx}`,
        }),
      );

      // Remove middle entry — gap in chain
      const entriesWithGap = [allEntries[0], allEntries[2]];
      mockRepo.findByDateRange.mockResolvedValue(entriesWithGap);
      mockRepo.findJustBefore.mockResolvedValue(null);

      const result = await service.verifyChain(
        new Date('2026-01-15'),
        new Date('2026-01-16'),
      );

      expect(result.valid).toBe(false);
    });
  });
});
