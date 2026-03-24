import type { EnrichedOpportunity } from '../../modules/arbitrage-detection/types/enriched-opportunity.type';

export const PAIR_CONCENTRATION_FILTER_TOKEN = 'IPairConcentrationFilter';

export interface IPairConcentrationFilter {
  filterOpportunities(
    opportunities: EnrichedOpportunity[],
    isPaper: boolean,
  ): Promise<ConcentrationFilterResult>;
}

export interface ConcentrationFilterResult {
  passed: EnrichedOpportunity[];
  filtered: FilteredOpportunityEntry[];
}

export interface FilteredOpportunityEntry {
  opportunity: EnrichedOpportunity;
  reason: string;
}
