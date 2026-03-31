import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CatalogSyncService } from './catalog-sync.service';
import { computeTitleSimilarity } from './external-pair-processor.service';
import { PlatformId } from '../../common/types/platform.type';
import type { ContractSummary } from '../../common/interfaces/contract-catalog-provider.interface';
import type { ExternalMatchedPair } from '../../common/types';

interface CatalogMatch {
  contract: ContractSummary;
  similarity: number;
}

@Injectable()
export class ExternalPairEnrichmentService {
  private readonly logger = new Logger(ExternalPairEnrichmentService.name);
  private readonly catalogMatchThreshold: number;

  constructor(
    private readonly catalogSync: CatalogSyncService,
    private readonly configService: ConfigService,
  ) {
    this.catalogMatchThreshold = Number(
      this.configService.get<number>(
        'EXTERNAL_PAIR_CATALOG_MATCH_THRESHOLD',
        0.5,
      ),
    );
  }

  async enrichPairs(
    pairs: ExternalMatchedPair[],
  ): Promise<ExternalMatchedPair[]> {
    const needsIdResolution = pairs.filter(
      (p) => !p.polymarketId || !p.kalshiId,
    );
    const needsClobToken = pairs.filter(
      (p) => p.polymarketId && p.kalshiId && !p.polymarketClobTokenId,
    );

    if (needsIdResolution.length === 0 && needsClobToken.length === 0) {
      return pairs;
    }

    let catalogs: Map<PlatformId, ContractSummary[]>;
    try {
      catalogs = await this.catalogSync.syncCatalogs();
    } catch (error) {
      this.logger.warn({
        message:
          'Catalog sync failed during enrichment — returning pairs unchanged',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      return pairs;
    }

    const polyContracts = catalogs.get(PlatformId.POLYMARKET) ?? [];
    const kalshiContracts = catalogs.get(PlatformId.KALSHI) ?? [];

    if (polyContracts.length === 0 || kalshiContracts.length === 0) {
      this.logger.warn({
        message: 'Empty catalog(s) — cannot enrich external pairs',
        data: {
          polymarket: polyContracts.length,
          kalshi: kalshiContracts.length,
        },
      });
      return pairs;
    }

    let enrichedCount = 0;

    const result = pairs.map((pair) => {
      // Predexon pairs: have IDs but may lack clobTokenId + metadata
      if (pair.polymarketId && pair.kalshiId) {
        if (pair.polymarketClobTokenId) {
          return pair; // Fully enriched already
        }
        // Exact contractId lookup — no fuzzy matching needed
        const polyContract = polyContracts.find(
          (c) => c.contractId === pair.polymarketId,
        );
        const kalshiContract = kalshiContracts.find(
          (c) => c.contractId === pair.kalshiId,
        );
        if (polyContract?.clobTokenId) {
          enrichedCount++;
          return {
            ...pair,
            polymarketClobTokenId: polyContract.clobTokenId,
            polymarketOutcomeLabel:
              polyContract.outcomeLabel ?? pair.polymarketOutcomeLabel,
            kalshiOutcomeLabel:
              kalshiContract?.outcomeLabel ?? pair.kalshiOutcomeLabel,
            settlementDate:
              pair.settlementDate ??
              polyContract.settlementDate ??
              kalshiContract?.settlementDate,
            category:
              pair.category ??
              polyContract.category ??
              kalshiContract?.category,
          };
        }
        return pair; // No catalog match — pass through as-is
      }

      const polyMatch = this.findBestMatch(pair.polymarketTitle, polyContracts);
      const kalshiMatch = this.findBestMatch(pair.kalshiTitle, kalshiContracts);

      if (
        polyMatch &&
        polyMatch.similarity >= this.catalogMatchThreshold &&
        kalshiMatch &&
        kalshiMatch.similarity >= this.catalogMatchThreshold
      ) {
        enrichedCount++;
        return {
          ...pair,
          polymarketId: polyMatch.contract.contractId,
          kalshiId: kalshiMatch.contract.contractId,
          settlementDate:
            polyMatch.contract.settlementDate ??
            kalshiMatch.contract.settlementDate,
          category:
            polyMatch.contract.category ?? kalshiMatch.contract.category,
          polymarketClobTokenId: polyMatch.contract.clobTokenId,
          polymarketOutcomeLabel: polyMatch.contract.outcomeLabel,
          kalshiOutcomeLabel: kalshiMatch.contract.outcomeLabel,
        };
      }

      return pair;
    });

    this.logger.log({
      message: 'External pair enrichment completed',
      data: {
        total: pairs.length,
        enriched: enrichedCount,
        passThrough:
          pairs.length - needsIdResolution.length - needsClobToken.length,
        unresolvable:
          needsIdResolution.length + needsClobToken.length - enrichedCount,
        catalogSizes: {
          polymarket: polyContracts.length,
          kalshi: kalshiContracts.length,
        },
      },
    });

    return result;
  }

  private findBestMatch(
    title: string,
    catalog: ContractSummary[],
  ): CatalogMatch | null {
    let best: CatalogMatch | null = null;

    for (const contract of catalog) {
      // Compare against both title and description for broader matching
      const titleSim = computeTitleSimilarity(title, contract.title);
      const descSim = contract.description
        ? computeTitleSimilarity(title, contract.description)
        : 0;
      const similarity = Math.max(titleSim, descSim);

      if (!best || similarity > best.similarity) {
        best = { contract, similarity };
      }
    }

    if (best && best.similarity === 0) return null;
    return best;
  }
}
