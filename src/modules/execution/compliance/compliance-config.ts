export interface ComplianceRule {
  platform: 'KALSHI' | 'POLYMARKET';
  blockedCategories: string[];
  notes?: string;
}

export interface ComplianceMatrixConfig {
  defaultAction: 'allow' | 'deny';
  rules: ComplianceRule[];
  jurisdiction?: {
    entity: string;
    kalshiRequirement?: string;
    polymarketNote?: string;
  };
}

export interface ComplianceCheckContext {
  pairId: string;
  opportunityId: string;
  primaryPlatform: string;
  secondaryPlatform: string;
  eventDescription: string;
  kalshiContractId: string;
  polymarketContractId: string;
}

export interface ComplianceDecision {
  approved: boolean;
  violations: ComplianceViolation[];
}

export interface ComplianceViolation {
  platform: 'KALSHI' | 'POLYMARKET';
  category: string;
  rule: string;
  timestamp: string;
}
