import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma.service';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * End-to-end test for complete engine lifecycle:
 * startup → polling cycle → graceful shutdown
 */
describe('Core Lifecycle (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  beforeEach(async () => {
    const mockPrismaService = {
      $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
      $connect: vi.fn().mockResolvedValue(undefined),
      $disconnect: vi.fn().mockResolvedValue(undefined),
      onModuleInit: vi.fn().mockResolvedValue(undefined),
      onModuleDestroy: vi.fn().mockResolvedValue(undefined),
      riskState: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
      platformHealthLog: {
        create: vi.fn().mockResolvedValue({}),
      },
      orderBookSnapshot: {
        create: vi.fn().mockResolvedValue({}),
      },
      contractMatch: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
      },
      riskOverrideLog: {
        create: vi.fn().mockResolvedValue({}),
      },
      openPosition: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      correlationCluster: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'uncategorized-id', slug: 'uncategorized' }),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
      },
      engineConfig: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({
          id: 'cfg-1',
          singletonKey: 'default',
          bankrollUsd: { toString: () => '10000' },
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
      backtestRun: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      backtestPosition: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
      calibrationRun: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
      historicalPrice: { findMany: vi.fn().mockResolvedValue([]), aggregate: vi.fn().mockResolvedValue({}), groupBy: vi.fn().mockResolvedValue([]) },
      historicalTrade: { findMany: vi.fn().mockResolvedValue([]), aggregate: vi.fn().mockResolvedValue({}) },
      historicalDepth: { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]) },
      dataCatalog: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}) },
      dataSourceFreshness: { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn().mockResolvedValue({}) },
      matchValidationReport: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
      ingestionQualityReport: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
      stressTestRun: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
      auditLog: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
      clusterTagMapping: { findMany: vi.fn().mockResolvedValue([]) },
      order: { findMany: vi.fn().mockResolvedValue([]) },
      riskOverrideLog: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useWebSocketAdapter(new WsAdapter(app));
    prisma = moduleFixture.get<PrismaService>(PrismaService);
    await app.init();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should start up, verify database, and initialize services', () => {
    expect(app).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(prisma.$queryRaw)).toHaveBeenCalled();
  });

  it.todo(
    'should run polling cycles during operation — verify scheduler triggers executeCycle and emits events',
  );

  it('should shut down gracefully without errors', async () => {
    expect(app).toBeDefined();

    // Trigger graceful shutdown - should complete without errors
    // Prisma disconnect is called automatically by NestJS lifecycle (onModuleDestroy)
    await expect(app.close()).resolves.not.toThrow();
  }, 15000); // 15s timeout for shutdown test

  it('should handle startup failure if database unavailable', async () => {
    // Create a new app instance with failing database
    const failingPrisma = {
      $queryRaw: vi.fn().mockRejectedValue(new Error('Connection failed')),
      $connect: vi.fn().mockResolvedValue(undefined),
      $disconnect: vi.fn().mockResolvedValue(undefined),
      onModuleInit: vi.fn().mockResolvedValue(undefined),
      onModuleDestroy: vi.fn().mockResolvedValue(undefined),
      riskState: {
        findFirst: vi.fn().mockRejectedValue(new Error('Connection failed')),
        upsert: vi.fn().mockRejectedValue(new Error('Connection failed')),
      },
      platformHealthLog: {
        create: vi.fn().mockRejectedValue(new Error('Connection failed')),
      },
      orderBookSnapshot: {
        create: vi.fn().mockRejectedValue(new Error('Connection failed')),
      },
      contractMatch: {
        findUnique: vi.fn().mockRejectedValue(new Error('Connection failed')),
        findMany: vi.fn().mockRejectedValue(new Error('Connection failed')),
        upsert: vi.fn().mockRejectedValue(new Error('Connection failed')),
      },
      openPosition: {
        findMany: vi.fn().mockRejectedValue(new Error('Connection failed')),
      },
      correlationCluster: {
        findUnique: vi.fn().mockRejectedValue(new Error('Connection failed')),
        findMany: vi.fn().mockRejectedValue(new Error('Connection failed')),
        create: vi.fn().mockRejectedValue(new Error('Connection failed')),
      },
      engineConfig: {
        findUnique: vi.fn().mockRejectedValue(new Error('Connection failed')),
        upsert: vi.fn().mockRejectedValue(new Error('Connection failed')),
      },
      backtestRun: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')), findFirst: vi.fn().mockRejectedValue(new Error('Connection failed')), create: vi.fn().mockRejectedValue(new Error('Connection failed')), update: vi.fn().mockRejectedValue(new Error('Connection failed')) },
      backtestPosition: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')), create: vi.fn().mockRejectedValue(new Error('Connection failed')) },
      calibrationRun: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')), create: vi.fn().mockRejectedValue(new Error('Connection failed')) },
      historicalPrice: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')), aggregate: vi.fn().mockRejectedValue(new Error('Connection failed')), groupBy: vi.fn().mockRejectedValue(new Error('Connection failed')) },
      historicalTrade: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')), aggregate: vi.fn().mockRejectedValue(new Error('Connection failed')) },
      historicalDepth: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')), groupBy: vi.fn().mockRejectedValue(new Error('Connection failed')) },
      dataCatalog: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')), findFirst: vi.fn().mockRejectedValue(new Error('Connection failed')), upsert: vi.fn().mockRejectedValue(new Error('Connection failed')) },
      dataSourceFreshness: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')), upsert: vi.fn().mockRejectedValue(new Error('Connection failed')) },
      matchValidationReport: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')), create: vi.fn().mockRejectedValue(new Error('Connection failed')) },
      ingestionQualityReport: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')), create: vi.fn().mockRejectedValue(new Error('Connection failed')) },
      stressTestRun: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')), create: vi.fn().mockRejectedValue(new Error('Connection failed')) },
      auditLog: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')), create: vi.fn().mockRejectedValue(new Error('Connection failed')) },
      clusterTagMapping: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')) },
      order: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')) },
      riskOverrideLog: { findMany: vi.fn().mockRejectedValue(new Error('Connection failed')), create: vi.fn().mockRejectedValue(new Error('Connection failed')) },
    };

    const failingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(failingPrisma)
      .compile();

    const failingApp =
      failingModule.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
      );
    failingApp.useWebSocketAdapter(new WsAdapter(failingApp));

    // Startup should fail when database connection fails
    await expect(failingApp.init()).rejects.toThrow('Connection failed');
  });
});
