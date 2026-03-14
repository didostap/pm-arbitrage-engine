import { Injectable } from '@nestjs/common';
import { EngineConfig, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service.js';

@Injectable()
export class EngineConfigRepository {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<EngineConfig | null> {
    return this.prisma.engineConfig.findUnique({
      where: { singletonKey: 'default' },
    });
  }

  async upsertBankroll(
    bankrollUsd: Prisma.Decimal | string,
  ): Promise<EngineConfig> {
    return this.prisma.engineConfig.upsert({
      where: { singletonKey: 'default' },
      update: { bankrollUsd },
      create: { bankrollUsd },
    });
  }
}
