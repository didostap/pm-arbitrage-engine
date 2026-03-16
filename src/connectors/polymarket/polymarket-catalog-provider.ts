import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  IContractCatalogProvider,
  ContractSummary,
  ResolutionOutcome,
  OutcomeToken,
} from '../../common/interfaces/contract-catalog-provider.interface.js';
import { PlatformId } from '../../common/types/platform.type.js';
import { PlatformApiError } from '../../common/errors/platform-api-error.js';
import { parseApiResponse } from '../common/parse-api-response.js';
import {
  polymarketEventSchema,
  polymarketResolutionMarketSchema,
} from './polymarket-response.schema.js';

const PAGE_LIMIT = 100;
const PAGE_DELAY_MS = 200;

interface PolymarketMarket {
  conditionId: string;
  question: string;
  description?: string;
  endDate?: string;
  clobTokenIds?: string;
  outcomes?: string;
}

interface PolymarketEvent {
  id: string;
  title: string;
  tags?: Array<{ label: string }>;
  markets?: PolymarketMarket[];
}

@Injectable()
export class PolymarketCatalogProvider implements IContractCatalogProvider {
  private readonly logger = new Logger(PolymarketCatalogProvider.name);
  private readonly gammaApiUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.gammaApiUrl = this.configService.get<string>(
      'POLYMARKET_GAMMA_API_URL',
      'https://gamma-api.polymarket.com',
    );
  }

  getPlatformId(): PlatformId {
    return PlatformId.POLYMARKET;
  }

  async listActiveContracts(): Promise<ContractSummary[]> {
    const contracts: ContractSummary[] = [];
    let offset = 0;

    try {
      let hasMore = true;
      while (hasMore) {
        const url = `${this.gammaApiUrl}/events?active=true&closed=false&limit=${PAGE_LIMIT}&offset=${offset}`;
        const response = await fetch(url);

        if (!response.ok) {
          throw new PlatformApiError(
            1020,
            `Polymarket Gamma API error: ${response.status} ${response.statusText}`,
            PlatformId.POLYMARKET,
            'error',
          );
        }

        const raw: unknown = await response.json();
        const events = parseApiResponse(polymarketEventSchema.array(), raw, {
          platform: PlatformId.POLYMARKET,
          operation: 'listActiveContracts',
        });

        for (const event of events) {
          if (!event.markets?.length) continue;
          for (const market of event.markets) {
            contracts.push(this.mapToContractSummary(event, market));
          }
        }

        hasMore = events.length >= PAGE_LIMIT;
        offset += events.length;

        if (hasMore) {
          await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
        }
      }
    } catch (error) {
      if (error instanceof PlatformApiError) throw error;
      throw new PlatformApiError(
        1021,
        `Polymarket catalog fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        PlatformId.POLYMARKET,
        'error',
      );
    }

    this.logger.log({
      message: 'Polymarket catalog fetched',
      data: { contractCount: contracts.length },
    });

    return contracts;
  }

  async getContractResolution(
    contractId: string,
  ): Promise<ResolutionOutcome | null> {
    try {
      const url = `${this.gammaApiUrl}/markets?condition_ids=${contractId}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new PlatformApiError(
          1022,
          `Polymarket resolution check failed: ${response.status} ${response.statusText}`,
          PlatformId.POLYMARKET,
          'error',
        );
      }

      const raw: unknown = await response.json();
      const markets = parseApiResponse(
        polymarketResolutionMarketSchema.array(),
        raw,
        { platform: PlatformId.POLYMARKET, operation: 'getResolutionOutcome' },
      );

      if (!markets.length) {
        return null;
      }

      const market = markets[0]!;
      const tokens = market.tokens ?? [];

      for (const token of tokens) {
        if (token.winner) {
          const outcome = token.outcome?.toLowerCase();
          if (outcome === 'yes' || outcome === 'no') {
            return { outcome, settled: true };
          }
          return { outcome: 'invalid', settled: true };
        }
      }

      return { outcome: null, settled: false };
    } catch (error) {
      if (error instanceof PlatformApiError) throw error;
      throw new PlatformApiError(
        1023,
        `Polymarket resolution check failed for ${contractId}: ${error instanceof Error ? error.message : String(error)}`,
        PlatformId.POLYMARKET,
        'error',
      );
    }
  }

  private mapToContractSummary(
    event: PolymarketEvent,
    market: PolymarketMarket,
  ): ContractSummary {
    const clobTokenIds = JSON.parse(market.clobTokenIds ?? '[]') as string[];
    const outcomeTokens = this.parseOutcomeTokens(
      market.outcomes,
      clobTokenIds,
    );

    return {
      contractId: market.conditionId,
      title: market.question,
      description: market.description
        ? `${market.question}: ${market.description}`
        : market.question,
      category: event.tags?.[0]?.label,
      settlementDate: market.endDate ? new Date(market.endDate) : undefined,
      clobTokenId: clobTokenIds[0],
      outcomeLabel: outcomeTokens?.[0]?.outcomeLabel,
      outcomeTokens,
      platform: PlatformId.POLYMARKET,
    };
  }

  private parseOutcomeTokens(
    outcomesJson: string | undefined,
    clobTokenIds: string[],
  ): OutcomeToken[] | undefined {
    if (!outcomesJson) return undefined;

    let outcomes: string[];
    try {
      outcomes = JSON.parse(outcomesJson) as string[];
    } catch {
      this.logger.warn({
        message: 'Failed to parse outcomes JSON',
        data: { outcomesJson },
      });
      return undefined;
    }

    if (!Array.isArray(outcomes) || outcomes.length === 0) return undefined;
    if (outcomes.length !== clobTokenIds.length) {
      this.logger.warn({
        message: 'Outcomes/clobTokenIds array length mismatch',
        data: {
          outcomesLength: outcomes.length,
          clobTokenIdsLength: clobTokenIds.length,
        },
      });
      return undefined;
    }

    return outcomes.map((label, i) => ({
      tokenId: clobTokenIds[i]!,
      outcomeLabel: label,
    }));
  }
}
