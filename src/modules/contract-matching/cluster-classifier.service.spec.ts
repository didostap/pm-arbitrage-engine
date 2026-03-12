import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClusterClassifierService } from './cluster-classifier.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import { AuditLogService } from '../monitoring/audit-log.service.js';
import { asClusterId, asMatchId } from '../../common/types/branded.type.js';

// Mock LLM providers
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      generateContent: vi.fn(),
    },
  })),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn(),
    },
  })),
}));

describe('ClusterClassifierService', () => {
  let service: ClusterClassifierService;
  let prisma: {
    correlationCluster: {
      findUnique: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    clusterTagMapping: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    contractMatch: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let auditLogService: { append: ReturnType<typeof vi.fn> };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let configService: { get: ReturnType<typeof vi.fn> };

  const uncategorizedCluster = {
    id: 'uncategorized-id',
    name: 'Uncategorized',
    slug: 'uncategorized',
    description: 'Default cluster',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    prisma = {
      correlationCluster: {
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
      },
      clusterTagMapping: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      contractMatch: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    };
    auditLogService = { append: vi.fn().mockResolvedValue(undefined) };
    eventEmitter = { emit: vi.fn() };
    configService = {
      get: vi.fn().mockImplementation((key: string, defaultVal?: unknown) => {
        const map: Record<string, unknown> = {
          CLUSTER_LLM_TIMEOUT_MS: 15000,
          LLM_PRIMARY_PROVIDER: 'gemini',
          LLM_PRIMARY_MODEL: 'gemini-2.5-flash',
          LLM_PRIMARY_API_KEY: 'test-key',
        };
        return map[key] ?? defaultVal;
      }),
    };

    // Default: uncategorized cluster exists
    prisma.correlationCluster.findUnique.mockResolvedValue(
      uncategorizedCluster,
    );

    const module = await Test.createTestingModule({
      providers: [
        ClusterClassifierService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: auditLogService },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(ClusterClassifierService);
    await service.onModuleInit();
  });

  describe('onModuleInit', () => {
    it('should cache the Uncategorized cluster ID', () => {
      // onModuleInit was called in beforeEach
      expect(prisma.correlationCluster.findUnique).toHaveBeenCalledWith({
        where: { slug: 'uncategorized' },
      });
    });

    it('should create Uncategorized cluster if not found', async () => {
      prisma.correlationCluster.findUnique.mockReset().mockResolvedValue(null);
      prisma.correlationCluster.create.mockResolvedValue({
        id: 'created-uncat-id',
        name: 'Uncategorized',
        slug: 'uncategorized',
      });

      await service.onModuleInit();

      expect(prisma.correlationCluster.create).toHaveBeenCalledWith({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          name: 'Uncategorized',
          slug: 'uncategorized',
        }),
      });
    });
  });

  describe('classifyMatch', () => {
    it('should return Uncategorized when both categories are null and LLM fails', async () => {
      // Both null → no fast-path → LLM fallback → LLM fails → Uncategorized
      const result = await service.classifyMatch(null, null, 'desc1', 'desc2');

      expect(result.clusterId).toBe(asClusterId('uncategorized-id'));
      expect(result.clusterName).toBe('Uncategorized');
    });

    it('should use fast-path when both sides map to the same cluster', async () => {
      const economicsCluster = {
        id: 'econ-id',
        name: 'Economics',
        slug: 'economics',
      };

      // First call for kalshi category
      prisma.clusterTagMapping.findFirst
        .mockResolvedValueOnce({
          clusterId: 'econ-id',
          cluster: economicsCluster,
        })
        // Second call for polymarket category
        .mockResolvedValueOnce({
          clusterId: 'econ-id',
          cluster: economicsCluster,
        });

      const result = await service.classifyMatch(
        'Federal Reserve',
        'FED-RATE',
        'Will the Fed raise rates?',
        'Federal Reserve interest rate decision',
      );

      expect(result.clusterId).toBe(asClusterId('econ-id'));
      expect(result.clusterName).toBe('Economics');
    });

    it('should use fast-path when only one side has a mapping', async () => {
      const politicsCluster = {
        id: 'politics-id',
        name: 'US Politics',
        slug: 'us-politics',
      };

      // kalshiCategory is null → kalshi lookup skipped entirely
      // Only polymarket lookup fires → returns the mapping
      prisma.clusterTagMapping.findFirst.mockResolvedValueOnce({
        clusterId: 'politics-id',
        cluster: politicsCluster,
      });

      const result = await service.classifyMatch(
        'Elections',
        null,
        'Who wins the election?',
        'Presidential election outcome',
      );

      expect(result.clusterId).toBe(asClusterId('politics-id'));
      expect(result.clusterName).toBe('US Politics');
    });

    it('should fall through to LLM when both sides map to different clusters', async () => {
      prisma.clusterTagMapping.findFirst
        .mockResolvedValueOnce({
          clusterId: 'econ-id',
          cluster: { id: 'econ-id', name: 'Economics', slug: 'economics' },
        })
        .mockResolvedValueOnce({
          clusterId: 'politics-id',
          cluster: {
            id: 'politics-id',
            name: 'US Politics',
            slug: 'us-politics',
          },
        });

      // LLM call will fail with default mocks → Uncategorized fallback
      const result = await service.classifyMatch(
        'Tags',
        'Category',
        'desc1',
        'desc2',
      );

      expect(result.clusterId).toBe(asClusterId('uncategorized-id'));
      expect(result.clusterName).toBe('Uncategorized');
    });
  });

  describe('getOrCreateCluster', () => {
    it('should return existing cluster by slug match', async () => {
      prisma.correlationCluster.findUnique.mockResolvedValue({
        id: 'existing-id',
        name: 'Economics',
        slug: 'economics',
      });

      const result = await service.getOrCreateCluster('Economics');
      expect(result).toBe(asClusterId('existing-id'));
    });

    it('should create new cluster when none matches', async () => {
      // First call is from onModuleInit (uncategorized), second is the slug lookup
      prisma.correlationCluster.findUnique
        .mockReset()
        .mockResolvedValueOnce(uncategorizedCluster) // onModuleInit
        .mockResolvedValueOnce(null); // slug lookup

      prisma.correlationCluster.create.mockResolvedValue({
        id: 'new-id',
        name: 'Climate',
        slug: 'climate',
      });

      // Re-init to reset internal state
      await service.onModuleInit();

      const result = await service.getOrCreateCluster(
        'Climate',
        'Climate events',
      );
      expect(result).toBe(asClusterId('new-id'));
      expect(prisma.correlationCluster.create).toHaveBeenCalledWith({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          name: 'Climate',
          slug: 'climate',
          description: 'Climate events',
        }),
      });
    });
  });

  describe('reassignCluster', () => {
    it('should update match clusterId and log audit', async () => {
      const matchId = asMatchId('match-1');
      const newClusterId = asClusterId('new-cluster-id');

      prisma.contractMatch.findUnique.mockResolvedValue({
        matchId: 'match-1',
        clusterId: 'old-cluster-id',
      });
      prisma.correlationCluster.findUnique.mockResolvedValue({
        id: 'new-cluster-id',
        name: 'New Cluster',
      });
      prisma.contractMatch.update.mockResolvedValue({
        matchId: 'match-1',
        clusterId: 'new-cluster-id',
      });

      const result = await service.reassignCluster(
        matchId,
        newClusterId,
        'Operator decided this belongs elsewhere',
      );

      expect(result.oldClusterId).toBe(asClusterId('old-cluster-id'));
      expect(result.newClusterId).toBe(asClusterId('new-cluster-id'));
      expect(prisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        data: { clusterId: 'new-cluster-id' },
      });
      expect(auditLogService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'risk.cluster.override',
          module: 'contract-matching',
        }),
      );
    });

    it('should throw when match does not exist', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(null);

      await expect(
        service.reassignCluster(
          asMatchId('non-existent'),
          asClusterId('cluster-id'),
          'rationale',
        ),
      ).rejects.toThrow();
    });

    it('should throw when target cluster does not exist', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue({
        matchId: 'match-1',
        clusterId: 'old-id',
      });
      prisma.correlationCluster.findUnique
        .mockReset()
        .mockResolvedValueOnce(uncategorizedCluster) // onModuleInit cached
        .mockResolvedValueOnce(null); // target cluster lookup

      await service.onModuleInit();

      await expect(
        service.reassignCluster(
          asMatchId('match-1'),
          asClusterId('non-existent'),
          'rationale',
        ),
      ).rejects.toThrow();
    });
  });

  describe('slug generation', () => {
    it('should generate correct slugs', async () => {
      prisma.correlationCluster.findUnique
        .mockReset()
        .mockResolvedValueOnce(uncategorizedCluster)
        .mockResolvedValueOnce(null); // no existing cluster

      prisma.correlationCluster.create.mockResolvedValue({
        id: 'new-id',
        name: 'US Politics & Elections',
        slug: 'us-politics-elections',
      });

      await service.onModuleInit();
      await service.getOrCreateCluster('US Politics & Elections');

      expect(prisma.correlationCluster.create).toHaveBeenCalledWith({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          slug: 'us-politics-elections',
        }),
      });
    });
  });
});
