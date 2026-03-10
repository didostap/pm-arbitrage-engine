import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  IContractCatalogProvider,
  ContractSummary,
} from '../../common/interfaces/contract-catalog-provider.interface.js';
import { PlatformId } from '../../common/types/platform.type.js';
import { PlatformApiError } from '../../common/errors/platform-api-error.js';

const PAGE_LIMIT = 100;
const PAGE_DELAY_MS = 200;

interface PolymarketMarket {
  conditionId: string;
  question: string;
  description?: string;
  endDate?: string;
  clobTokenIds?: string;
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

        const events = (await response.json()) as PolymarketEvent[];

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

  private mapToContractSummary(
    event: PolymarketEvent,
    market: PolymarketMarket,
  ): ContractSummary {
    const clobTokenIds = JSON.parse(market.clobTokenIds ?? '[]') as string[];

    return {
      contractId: market.conditionId,
      title: market.question,
      description: market.description
        ? `${market.question}: ${market.description}`
        : market.question,
      category: event.tags?.[0]?.label,
      settlementDate: market.endDate ? new Date(market.endDate) : undefined,
      clobTokenId: clobTokenIds[0],
      platform: PlatformId.POLYMARKET,
    };
  }
}
