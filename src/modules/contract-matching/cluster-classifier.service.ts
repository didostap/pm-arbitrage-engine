import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import type { IClusterClassifier } from '../../common/interfaces/cluster-classifier.interface.js';
import { PrismaService } from '../../common/prisma.service.js';
import { AuditLogService } from '../monitoring/audit-log.service.js';
import {
  asClusterId,
  type ClusterId,
  type MatchId,
} from '../../common/types/branded.type.js';
import type { ClusterAssignment } from '../../common/types/risk.type.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import { SystemHealthError } from '../../common/errors/system-health-error.js';
import { clusterPlatformSchema } from '../../common/schemas/prisma-json.schema.js';

/**
 * Classifies contract matches into correlation clusters.
 * Uses deterministic fast-path (ClusterTagMapping lookup) first;
 * falls back to LLM classification for unknown categories.
 */
@Injectable()
export class ClusterClassifierService
  implements IClusterClassifier, OnModuleInit
{
  private readonly logger = new Logger(ClusterClassifierService.name);
  private uncategorizedClusterId!: ClusterId;
  private readonly timeoutMs: number;
  private readonly llmProvider: string;
  private readonly llmModel: string;
  private readonly llmApiKey: string;
  private anthropicClient: Anthropic | null = null;
  private geminiClient: GoogleGenAI | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly configService: ConfigService,
  ) {
    this.timeoutMs = this.configService.get<number>(
      'CLUSTER_LLM_TIMEOUT_MS',
      15000,
    );
    this.llmProvider = this.configService.get<string>(
      'LLM_PRIMARY_PROVIDER',
      'gemini',
    );
    this.llmModel = this.configService.get<string>(
      'LLM_PRIMARY_MODEL',
      'gemini-2.5-flash',
    );
    this.llmApiKey = this.configService.get<string>('LLM_PRIMARY_API_KEY', '');
  }

  async onModuleInit(): Promise<void> {
    let uncategorized = await this.prisma.correlationCluster.findUnique({
      where: { slug: 'uncategorized' },
    });
    if (!uncategorized) {
      this.logger.warn({
        message: 'Uncategorized cluster not found — creating programmatically',
      });
      uncategorized = await this.prisma.correlationCluster.create({
        data: {
          name: 'Uncategorized',
          slug: 'uncategorized',
          description:
            'Default cluster for unclassified or failed-to-classify matches',
        },
      });
    }
    this.uncategorizedClusterId = asClusterId(uncategorized.id);
  }

  async classifyMatch(
    polyCategory: string | null,
    kalshiCategory: string | null,
    polyDescription: string,
    kalshiDescription: string,
  ): Promise<ClusterAssignment> {
    try {
      // Fast-path: check ClusterTagMapping for exact matches
      const fastPathResult = await this.tryFastPath(
        polyCategory,
        kalshiCategory,
      );

      if (fastPathResult) {
        return fastPathResult;
      }

      // LLM fallback
      return await this.classifyViaLlm(
        polyCategory,
        kalshiCategory,
        polyDescription,
        kalshiDescription,
      );
    } catch (error) {
      this.logger.warn({
        message: 'Cluster classification failed, assigning to Uncategorized',
        data: {
          polyCategory,
          kalshiCategory,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return this.uncategorizedAssignment();
    }
  }

  async getOrCreateCluster(
    name: string,
    description?: string,
  ): Promise<ClusterId> {
    const slug = this.generateSlug(name);
    if (!slug) {
      this.logger.debug({
        message: 'Empty slug generated — falling back to Uncategorized',
        data: { name },
      });
      return this.uncategorizedClusterId;
    }
    const existing = await this.prisma.correlationCluster.findUnique({
      where: { slug },
    });

    if (existing) {
      return asClusterId(existing.id);
    }

    try {
      const created = await this.prisma.correlationCluster.create({
        data: { name, slug, description: description ?? null },
      });
      return asClusterId(created.id);
    } catch (error) {
      // Handle unique constraint violation (race condition)
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'P2002'
      ) {
        const raced = await this.prisma.correlationCluster.findUnique({
          where: { slug },
        });
        if (raced) return asClusterId(raced.id);
      }
      throw error;
    }
  }

  async reassignCluster(
    matchId: MatchId,
    newClusterId: ClusterId,
    rationale: string,
  ): Promise<{ oldClusterId: ClusterId | null; newClusterId: ClusterId }> {
    const match = await this.prisma.contractMatch.findUnique({
      where: { matchId: matchId as string },
    });

    if (!match) {
      throw new SystemHealthError(
        4007,
        `ContractMatch not found: ${matchId}`,
        'warning',
        'contract-matching',
      );
    }

    const targetCluster = await this.prisma.correlationCluster.findUnique({
      where: { id: newClusterId as string },
    });

    if (!targetCluster) {
      throw new SystemHealthError(
        4007,
        `CorrelationCluster not found: ${newClusterId}`,
        'warning',
        'risk-management',
      );
    }

    const oldClusterId = match.clusterId ? asClusterId(match.clusterId) : null;

    await this.prisma.contractMatch.update({
      where: { matchId: matchId as string },
      data: { clusterId: newClusterId as string },
    });

    // Audit log AFTER transaction commits (see story dev notes on hash-chain safety)
    await this.auditLogService.append({
      eventType: EVENT_NAMES.CLUSTER_OVERRIDE,
      module: 'contract-matching',
      details: {
        matchId: matchId as string,
        oldClusterId: oldClusterId as string | null,
        newClusterId: newClusterId as string,
        rationale,
      },
    });

    return { oldClusterId, newClusterId };
  }

  // === Private helpers ===

  private async tryFastPath(
    polyCategory: string | null,
    kalshiCategory: string | null,
  ): Promise<ClusterAssignment | null> {
    type MappingRow = {
      clusterId: string;
      cluster: { id: string; name: string; slug: string };
    };

    // Use findMany to detect ambiguous categories (one category → multiple clusters)
    let kalshiMappings: MappingRow[] = [];
    let polyMappings: MappingRow[] = [];

    if (kalshiCategory) {
      kalshiMappings = await this.prisma.clusterTagMapping.findMany({
        where: { platform: 'kalshi', rawCategory: kalshiCategory },
        include: { cluster: true },
      });
    }

    if (polyCategory) {
      polyMappings = await this.prisma.clusterTagMapping.findMany({
        where: { platform: 'polymarket', rawCategory: polyCategory },
        include: { cluster: true },
      });
    }

    // Ambiguous category (maps to multiple clusters) → treat as unmapped
    const kalshiUnique =
      kalshiMappings.length === 1 ? kalshiMappings[0]! : null;
    const polyUnique = polyMappings.length === 1 ? polyMappings[0]! : null;

    // Both unambiguously mapped to same cluster → fast-path assign
    if (
      kalshiUnique &&
      polyUnique &&
      kalshiUnique.clusterId === polyUnique.clusterId
    ) {
      return {
        clusterId: asClusterId(kalshiUnique.clusterId),
        clusterName: kalshiUnique.cluster.name,
        rawCategories: [
          ...(kalshiCategory
            ? [{ platform: 'kalshi', rawCategory: kalshiCategory }]
            : []),
          ...(polyCategory
            ? [{ platform: 'polymarket', rawCategory: polyCategory }]
            : []),
        ],
        wasLlmClassified: false,
      };
    }

    // All other cases (conflict, one-sided, ambiguous, neither mapped) → fall through to LLM.
    // One-sided mappings are NOT propagated to avoid snowballing broad categories
    // (e.g., "Sports" → FIFA should not auto-assign NHL, UFC, boxing to FIFA).
    return null;
  }

  private async classifyViaLlm(
    polyCategory: string | null,
    kalshiCategory: string | null,
    polyDescription: string,
    kalshiDescription: string,
  ): Promise<ClusterAssignment> {
    const existingClusters = await this.prisma.correlationCluster.findMany({
      select: { name: true, slug: true },
    });

    const existingNames = existingClusters.map((c) => c.name);

    const prompt = this.buildClassificationPrompt(
      polyCategory,
      kalshiCategory,
      polyDescription,
      kalshiDescription,
      existingNames,
    );

    const clusterName = await this.callLlm(prompt);
    const clusterId = await this.getOrCreateCluster(clusterName);

    // Insert tag mappings for future fast-path
    if (kalshiCategory) {
      await this.safeInsertTagMapping(
        clusterId as string,
        'kalshi',
        kalshiCategory,
      );
    }
    if (polyCategory) {
      await this.safeInsertTagMapping(
        clusterId as string,
        'polymarket',
        polyCategory,
      );
    }

    const cluster = await this.prisma.correlationCluster.findUnique({
      where: { id: clusterId as string },
    });

    return {
      clusterId,
      clusterName: cluster?.name ?? clusterName,
      rawCategories: [
        ...(kalshiCategory
          ? [{ platform: 'kalshi', rawCategory: kalshiCategory }]
          : []),
        ...(polyCategory
          ? [{ platform: 'polymarket', rawCategory: polyCategory }]
          : []),
      ],
      wasLlmClassified: true,
    };
  }

  private buildClassificationPrompt(
    polyCategory: string | null,
    kalshiCategory: string | null,
    polyDescription: string,
    kalshiDescription: string,
    existingClusterNames: string[],
  ): string {
    return `You are classifying prediction market contract pairs into correlation clusters for risk management.

A correlation cluster groups contracts that share the same underlying risk factor (e.g., "US Politics", "Federal Reserve Policy", "Cryptocurrency", "Sports - NFL").

Given the following contract pair:
- Kalshi category: ${kalshiCategory ?? 'N/A'}
- Polymarket category: ${polyCategory ?? 'N/A'}
- Kalshi description: ${kalshiDescription}
- Polymarket description: ${polyDescription}

Existing clusters: ${existingClusterNames.length > 0 ? existingClusterNames.join(', ') : 'None yet'}

Respond with ONLY a JSON object: {"clusterName": "<name>"}

Rules:
- If the contract pair matches an existing cluster, use that exact name
- If no existing cluster matches, create a short, descriptive name (2-4 words)
- Focus on the underlying risk factor, not the specific contract details
- Do NOT use "Uncategorized" — always attempt a meaningful classification`;
  }

  private async callLlm(prompt: string): Promise<string> {
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`LLM classification timed out after ${this.timeoutMs}ms`),
          ),
        this.timeoutMs,
      );
    });

    try {
      let apiPromise: Promise<string>;

      if (this.llmProvider === 'anthropic') {
        if (!this.anthropicClient) {
          this.anthropicClient = new Anthropic({ apiKey: this.llmApiKey });
        }
        apiPromise = this.anthropicClient.messages
          .create({
            model: this.llmModel,
            max_tokens: 256,
            messages: [{ role: 'user', content: prompt }],
          })
          .then((response) => {
            const textBlock = response.content.find((b) => b.type === 'text');
            return textBlock && 'text' in textBlock ? textBlock.text : '';
          });
      } else {
        if (!this.geminiClient) {
          this.geminiClient = new GoogleGenAI({ apiKey: this.llmApiKey });
        }
        apiPromise = this.geminiClient.models
          .generateContent({
            model: this.llmModel,
            contents: prompt,
          })
          .then((response) => response.text ?? '');
      }

      const text = await Promise.race([apiPromise, timeoutPromise]);

      // Strip markdown code fences if present (LLMs may wrap JSON in ```json ... ```)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const cleanText = jsonMatch ? jsonMatch[0] : text;
      const parsed = JSON.parse(cleanText) as { clusterName?: string };
      if (!parsed.clusterName || typeof parsed.clusterName !== 'string') {
        throw new Error('Invalid LLM response: missing clusterName');
      }
      return parsed.clusterName.trim();
    } catch (error) {
      this.logger.warn({
        message: 'LLM cluster classification failed',
        data: {
          provider: this.llmProvider,
          model: this.llmModel,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    } finally {
      clearTimeout(timer!);
    }
  }

  private async safeInsertTagMapping(
    clusterId: string,
    platform: string,
    rawCategory: string,
  ): Promise<void> {
    // Validate platform value before inserting (DB column is plain string)
    const validPlatform = clusterPlatformSchema.parse(platform);
    try {
      await this.prisma.clusterTagMapping.create({
        data: { clusterId, platform: validPlatform, rawCategory },
      });
    } catch (error) {
      // Handle unique constraint violation (concurrent insert race)
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'P2002'
      ) {
        // Another thread won the race — treat as success
        return;
      }
      throw error;
    }
  }

  private uncategorizedAssignment(): ClusterAssignment {
    return {
      clusterId: this.uncategorizedClusterId,
      clusterName: 'Uncategorized',
      rawCategories: [],
      wasLlmClassified: false,
    };
  }

  /**
   * Slug generation: lowercase, replace non-alphanumeric with hyphens, trim hyphens
   */
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}
