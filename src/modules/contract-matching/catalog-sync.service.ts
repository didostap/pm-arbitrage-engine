import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  KALSHI_CATALOG_TOKEN,
  POLYMARKET_CATALOG_TOKEN,
} from '../../common/interfaces/contract-catalog-provider.interface.js';
import type {
  IContractCatalogProvider,
  ContractSummary,
} from '../../common/interfaces/contract-catalog-provider.interface.js';
import { PlatformId } from '../../common/types/platform.type.js';

@Injectable()
export class CatalogSyncService {
  private readonly logger = new Logger(CatalogSyncService.name);

  constructor(
    @Inject(KALSHI_CATALOG_TOKEN)
    private readonly kalshiCatalog: IContractCatalogProvider,
    @Inject(POLYMARKET_CATALOG_TOKEN)
    private readonly polymarketCatalog: IContractCatalogProvider,
  ) {}

  async syncCatalogs(): Promise<Map<PlatformId, ContractSummary[]>> {
    const results = new Map<PlatformId, ContractSummary[]>();

    for (const provider of [this.kalshiCatalog, this.polymarketCatalog]) {
      try {
        const contracts = await provider.listActiveContracts();
        results.set(provider.getPlatformId(), contracts);
      } catch (error) {
        this.logger.error({
          message: 'Catalog sync failed for platform',
          data: {
            platform: provider.getPlatformId(),
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    return results;
  }
}
