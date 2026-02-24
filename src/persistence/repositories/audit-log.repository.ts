import { Injectable } from '@nestjs/common';
import { Prisma, AuditLog } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service.js';

@Injectable()
export class AuditLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.AuditLogCreateInput): Promise<AuditLog> {
    return this.prisma.auditLog.create({ data });
  }

  async findLast(): Promise<AuditLog | null> {
    return this.prisma.auditLog.findFirst({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByDateRange(startDate: Date, endDate: Date): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findByEventType(
    eventType: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: {
        eventType,
        ...(startDate && endDate
          ? { createdAt: { gte: startDate, lte: endDate } }
          : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findJustBefore(date: Date): Promise<AuditLog | null> {
    return this.prisma.auditLog.findFirst({
      where: { createdAt: { lt: date } },
      orderBy: { createdAt: 'desc' },
    });
  }
}
