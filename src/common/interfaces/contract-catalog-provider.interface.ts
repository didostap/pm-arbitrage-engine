import { PlatformId } from '../types/platform.type.js';

export interface ContractSummary {
  contractId: string; // Kalshi: market ticker; Polymarket: conditionId
  title: string; // Short title for pre-filter text comparison
  description: string; // Full description for LLM scoring
  category?: string; // Kalshi: series_ticker; Polymarket: primary tag
  settlementDate?: Date; // Expected resolution/close date
  clobTokenId?: string; // Polymarket CLOB token ID (YES outcome)
  platform: PlatformId;
}

export interface ResolutionOutcome {
  outcome: 'yes' | 'no' | 'invalid' | null;
  settled: boolean;
  rawStatus?: string;
}

export interface IContractCatalogProvider {
  listActiveContracts(): Promise<ContractSummary[]>;
  getPlatformId(): PlatformId;
  getContractResolution(contractId: string): Promise<ResolutionOutcome | null>;
}

export const KALSHI_CATALOG_TOKEN = 'IContractCatalogProvider:Kalshi';
export const POLYMARKET_CATALOG_TOKEN = 'IContractCatalogProvider:Polymarket';
