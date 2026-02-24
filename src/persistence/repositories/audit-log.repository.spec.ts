import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditLogRepository } from './audit-log.repository.js';
import { PrismaService } from '../../common/prisma.service.js';

const mockAuditLog = {
  id: 'audit-1',
  createdAt: new Date('2026-01-15T10:00:00Z'),
  eventType: 'execution.order.filled',
  module: 'execution',
  correlationId: 'corr-123',
  details: { orderId: 'order-1' },
  previousHash: '0'.repeat(64),
  currentHash: 'a'.repeat(64),
};

describe('AuditLogRepository', () => {
  let repository: AuditLogRepository;
  let mockPrisma: {
    auditLog: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    mockPrisma = {
      auditLog: {
        create: vi.fn().mockResolvedValue(mockAuditLog),
        findFirst: vi.fn().mockResolvedValue(mockAuditLog),
        findMany: vi.fn().mockResolvedValue([mockAuditLog]),
      },
    };

    repository = new AuditLogRepository(mockPrisma as unknown as PrismaService);
  });

  it('should create audit log entry with all fields', async () => {
    const data = {
      eventType: 'execution.order.filled',
      module: 'execution',
      correlationId: 'corr-123',
      details: { orderId: 'order-1' },
      previousHash: '0'.repeat(64),
      currentHash: 'a'.repeat(64),
    };

    const result = await repository.create(data);

    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({ data });
    expect(result).toEqual(mockAuditLog);
  });

  it('should findLast() returning most recent entry', async () => {
    const result = await repository.findLast();

    expect(mockPrisma.auditLog.findFirst).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toEqual(mockAuditLog);
  });

  it('should findLast() returning null when table is empty', async () => {
    mockPrisma.auditLog.findFirst.mockResolvedValue(null);

    const result = await repository.findLast();

    expect(result).toBeNull();
  });

  it('should findByDateRange() returning entries in ascending order', async () => {
    const start = new Date('2026-01-01');
    const end = new Date('2026-01-31');

    await repository.findByDateRange(start, end);

    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        createdAt: { gte: start, lte: end },
      },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('should findByEventType() filtering correctly', async () => {
    const start = new Date('2026-01-01');
    const end = new Date('2026-01-31');

    await repository.findByEventType('execution.order.filled', start, end);

    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        eventType: 'execution.order.filled',
        createdAt: { gte: start, lte: end },
      },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('should findByEventType() without date range', async () => {
    await repository.findByEventType('execution.order.filled');

    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        eventType: 'execution.order.filled',
      },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('should findJustBefore() returning entry before given date', async () => {
    const date = new Date('2026-01-15');

    await repository.findJustBefore(date);

    expect(mockPrisma.auditLog.findFirst).toHaveBeenCalledWith({
      where: { createdAt: { lt: date } },
      orderBy: { createdAt: 'desc' },
    });
  });
});
