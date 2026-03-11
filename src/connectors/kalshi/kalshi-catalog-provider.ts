import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import {
  Configuration,
  EventsApi,
  MarketApi,
  type KalshiEvent,
  type KalshiMarketDetail,
} from 'kalshi-typescript';
import type {
  IContractCatalogProvider,
  ContractSummary,
  ResolutionOutcome,
} from '../../common/interfaces/contract-catalog-provider.interface.js';
import { PlatformId } from '../../common/types/platform.type.js';
import { PlatformApiError } from '../../common/errors/platform-api-error.js';

const PAGE_LIMIT = 200;
const PAGE_DELAY_MS = 200;

@Injectable()
export class KalshiCatalogProvider implements IContractCatalogProvider {
  private readonly logger = new Logger(KalshiCatalogProvider.name);
  private readonly eventsApi: EventsApi;
  private readonly marketApi: MarketApi;

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
    this.marketApi = new MarketApi(config);
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

  async getContractResolution(
    contractId: string,
  ): Promise<ResolutionOutcome | null> {
    try {
      const response = await this.marketApi.getMarket(contractId);
      const market = response.data.market;

      if (market.status === 'settled') {
        const result = market.result?.toLowerCase();
        if (result === 'yes' || result === 'no') {
          return { outcome: result, settled: true, rawStatus: market.status };
        }
        return { outcome: 'invalid', settled: true, rawStatus: market.status };
      }

      return {
        outcome: null,
        settled: false,
        rawStatus: market.status,
      };
    } catch (error) {
      if (error instanceof PlatformApiError) throw error;
      throw new PlatformApiError(
        1011,
        `Kalshi resolution check failed for ${contractId}: ${error instanceof Error ? error.message : String(error)}`,
        PlatformId.KALSHI,
        'error',
      );
    }
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
    const rawDate =
      market.expected_expiration_time ||
      market.expiration_time ||
      market.close_time;

    if (!market.expected_expiration_time && !market.expiration_time) {
      this.logger.warn({
        message:
          'Kalshi market missing expected_expiration_time and expiration_time',
        data: {
          ticker: market.ticker,
          fallback: market.close_time ? 'close_time' : 'none',
        },
      });
    }

    const parsedDate = rawDate ? new Date(rawDate) : undefined;
    if (rawDate && parsedDate && isNaN(parsedDate.getTime())) {
      this.logger.warn({
        message: 'Kalshi market has invalid date format',
        data: { ticker: market.ticker, rawDate },
      });
    }
    const settlementDate =
      parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : undefined;

    return {
      contractId: market.ticker,
      title,
      description: parts.join('\n'),
      category: event.series_ticker || event.category,
      settlementDate,
      platform: PlatformId.KALSHI,
    };
  }
}
