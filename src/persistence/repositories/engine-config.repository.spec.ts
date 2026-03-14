import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EngineConfigRepository } from './engine-config.repository.js';
import { PrismaService } from '../../common/prisma.service.js';

const mockConfig = {
  id: 'cfg-1',
  singletonKey: 'default',
  bankrollUsd: { toString: () => '10000.00000000' },
  createdAt: new Date('2026-03-14T10:00:00Z'),
  updatedAt: new Date('2026-03-14T10:00:00Z'),
};

describe('EngineConfigRepository', () => {
  let repository: EngineConfigRepository;
  let mockPrisma: {
    engineConfig: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    mockPrisma = {
      engineConfig: {
        findUnique: vi.fn().mockResolvedValue(mockConfig),
        upsert: vi.fn().mockResolvedValue(mockConfig),
      },
    };

    repository = new EngineConfigRepository(
      mockPrisma as unknown as PrismaService,
    );
  });

  it('should get() the singleton config row', async () => {
    const result = await repository.get();

    expect(mockPrisma.engineConfig.findUnique).toHaveBeenCalledWith({
      where: { singletonKey: 'default' },
    });
    expect(result).toEqual(mockConfig);
  });

  it('should get() returning null when no row exists', async () => {
    mockPrisma.engineConfig.findUnique.mockResolvedValue(null);

    const result = await repository.get();

    expect(result).toBeNull();
  });

  it('should upsertBankroll() creating row when none exists', async () => {
    await repository.upsertBankroll('15000');

    expect(mockPrisma.engineConfig.upsert).toHaveBeenCalledWith({
      where: { singletonKey: 'default' },
      update: { bankrollUsd: '15000' },
      create: { bankrollUsd: '15000' },
    });
  });

  it('should upsertBankroll() updating existing row', async () => {
    await repository.upsertBankroll('20000.50');

    expect(mockPrisma.engineConfig.upsert).toHaveBeenCalledWith({
      where: { singletonKey: 'default' },
      update: { bankrollUsd: '20000.50' },
      create: { bankrollUsd: '20000.50' },
    });
  });

  it('should upsertBankroll() returning the upserted config', async () => {
    const result = await repository.upsertBankroll('10000');

    expect(result).toEqual(mockConfig);
  });
});
