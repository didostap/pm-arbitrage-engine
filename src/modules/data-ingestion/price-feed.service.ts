import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { IPriceFeedService } from '../../common/interfaces/price-feed-service.interface.js';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface.js';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants.js';
import { FinancialMath } from '../../common/utils/financial-math.js';
import { asContractId } from '../../common/types/branded.type.js';

@Injectable()
export class PriceFeedService implements IPriceFeedService {
  private readonly logger = new Logger(PriceFeedService.name);

  constructor(
    @Inject(KALSHI_CONNECTOR_TOKEN)
    private readonly kalshiConnector: IPlatformConnector,
    @Inject(POLYMARKET_CONNECTOR_TOKEN)
    private readonly polymarketConnector: IPlatformConnector,
  ) {}

  async getCurrentClosePrice(
    platform: string,
    contractId: string,
    side: 'buy' | 'sell',
  ): Promise<Decimal | null> {
    const connector = this.getConnector(platform);
    try {
      const orderBook = await connector.getOrderBook(asContractId(contractId));
      if (side === 'buy') {
        // Selling to close → use best bid
        if (orderBook.bids.length === 0) return null;
        return new Decimal(orderBook.bids[0]!.price);
      }
      // Buying to close → use best ask
      if (orderBook.asks.length === 0) return null;
      return new Decimal(orderBook.asks[0]!.price);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to fetch close price — order book unavailable',
        data: {
          platform,
          contractId,
          side,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return null;
    }
  }

  getTakerFeeRate(platform: string, price: Decimal): Decimal {
    const connector = this.getConnector(platform);
    const feeSchedule = connector.getFeeSchedule();
    return FinancialMath.calculateTakerFeeRate(price, feeSchedule);
  }

  private getConnector(platform: string): IPlatformConnector {
    if (platform.toLowerCase() === 'kalshi') return this.kalshiConnector;
    return this.polymarketConnector;
  }
}
