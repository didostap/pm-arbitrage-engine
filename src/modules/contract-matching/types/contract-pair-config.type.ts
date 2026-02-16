/**
 * Runtime type for validated contract pairs.
 * Transformed from ContractPairDto during config loading.
 * No decorators — clean runtime interface for the rest of the system.
 */
export interface ContractPairConfig {
  polymarketContractId: string;
  kalshiContractId: string;
  eventDescription: string;
  operatorVerificationTimestamp: Date;
  primaryLeg: 'kalshi' | 'polymarket';
}
