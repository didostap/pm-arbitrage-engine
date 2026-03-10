import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import {
  Configuration,
  EventsApi,
  type KalshiEvent,
  type KalshiMarketDetail,
} from 'kalshi-typescript';
import type {
  IContractCatalogProvider,
  ContractSummary,
} from '../../common/interfaces/contract-catalog-provider.interface.js';
import { PlatformId } from '../../common/types/platform.type.js';
import { PlatformApiError } from '../../common/errors/platform-api-error.js';

const PAGE_LIMIT = 200;
const PAGE_DELAY_MS = 200;

@Injectable()
export class KalshiCatalogProvider implements IContractCatalogProvider {
  private readonly logger = new Logger(KalshiCatalogProvider.name);
  private readonly eventsApi: EventsApi;

  constructor(private readonly configService: ConfigService) {
    const apiKeyId = this.configService.get<string>('KALSHI_API_KEY_ID', '');
    const privateKeyPath = this.configService.get<string>(
      'KALSHI_PRIVATE_KEY_PATH',
      '',
    );
    const baseUrl = this.configService.get<string>(
      'KALSHI_API_BASE_URL',
      'https://demo-api.kalshi.co/trade-api/v2',
    );

    let privateKeyPem = '';
    if (privateKeyPath) {
      try {
        privateKeyPem = readFileSync(privateKeyPath, 'utf-8');
      } catch {
        this.logger.warn({
          message:
            'Could not read private key file for catalog provider; authentication may fail',
        });
      }
    }

    const config = new Configuration({
      apiKey: apiKeyId,
      privateKeyPem,
      basePath: baseUrl,
    });

    this.eventsApi = new EventsApi(config);
  }

  getPlatformId(): PlatformId {
    return PlatformId.KALSHI;
  }

  async listActiveContracts(): Promise<ContractSummary[]> {
    const contracts: ContractSummary[] = [];
    let cursor = '';

    try {
      do {
        const response = await this.eventsApi.getEvents(
          PAGE_LIMIT,
          cursor || undefined,
          true, // withNestedMarkets
          undefined, // withMilestones
          'open', // status
        );

        const { events, cursor: nextCursor } = response.data;

        for (const event of events) {
          if (!event.markets?.length) continue;
          for (const market of event.markets) {
            contracts.push(this.mapToContractSummary(event, market));
          }
        }

        cursor = nextCursor;

        if (cursor) {
          await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
        }
      } while (cursor);
    } catch (error) {
      if (error instanceof PlatformApiError) throw error;
      throw new PlatformApiError(
        1010,
        `Kalshi catalog fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        PlatformId.KALSHI,
        'error',
      );
    }

    this.logger.log({
      message: 'Kalshi catalog fetched',
      data: { contractCount: contracts.length },
    });

    return contracts;
  }

  private mapToContractSummary(
    event: KalshiEvent,
    market: KalshiMarketDetail,
  ): ContractSummary {
    const title = event.title;
    const marketDetail =
      market.yes_sub_title || market.subtitle || market.title;
    const parts = [title];
    if (marketDetail) parts.push(marketDetail);
    if (market.rules_primary) parts.push(market.rules_primary);
    return {
      contractId: market.ticker,
      title,
      description: parts.join('\n'),
      category: event.series_ticker || event.category,
      settlementDate: market.close_time
        ? new Date(market.close_time)
        : undefined,
      platform: PlatformId.KALSHI,
    };
  }
}
