export type ExternalMatchSource = 'oddspipe' | 'predexon';

export interface ExternalMatchedPair {
  polymarketId: string | null;
  kalshiId: string | null;
  polymarketTitle: string;
  kalshiTitle: string;
  source: ExternalMatchSource;
  similarity: number | null;
  spreadData: {
    yesDiff: number;
    polyYesPrice: number;
    kalshiYesPrice: number;
  } | null;
  /** Enrichment metadata — populated by catalog-based ID resolution */
  settlementDate?: Date;
  category?: string;
  polymarketClobTokenId?: string;
  polymarketOutcomeLabel?: string;
  kalshiOutcomeLabel?: string;
}

export type ValidationCategory =
  | 'confirmed'
  | 'our-only'
  | 'external-only'
  | 'conflict';

export interface ValidationReportEntry {
  category: ValidationCategory;
  isKnowledgeBaseCandidate: boolean;
  ourMatch?: {
    matchId: string;
    polymarketContractId: string;
    kalshiContractId: string;
    polymarketDescription?: string;
    kalshiDescription?: string;
    confidenceScore?: number;
    operatorApproved: boolean;
  };
  oddsPipeMatch?: {
    polymarketTitle: string;
    kalshiTitle: string;
    yesDiff?: number;
    polyYesPrice?: number;
    kalshiYesPrice?: number;
  };
  predexonMatch?: {
    polymarketConditionId: string;
    kalshiId: string;
    polymarketTitle: string;
    kalshiTitle: string;
    similarity?: number;
  };
  conflictDescription?: string;
  notes: string;
}

export interface ValidationReportSummary {
  confirmedCount: number;
  ourOnlyCount: number;
  externalOnlyCount: number;
  conflictCount: number;
  totalOurMatches: number;
  totalOddsPipePairs: number;
  totalPredexonPairs: number;
  sourcesQueried: ExternalMatchSource[];
}
