declare const __brand: unique symbol;

/**
 * Creates a nominal (branded) type that is structurally incompatible with
 * other branded types, preventing accidental ID swapping at compile time.
 * At runtime, branded types ARE plain strings — zero overhead.
 */
export type Branded<T, B extends string> = T & { readonly [__brand]: B };

// === Entity ID Types ===
export type PositionId = Branded<string, 'PositionId'>;
export type OrderId = Branded<string, 'OrderId'>;
export type PairId = Branded<string, 'PairId'>;
export type MatchId = Branded<string, 'MatchId'>;
export type ContractId = Branded<string, 'ContractId'>;
export type OpportunityId = Branded<string, 'OpportunityId'>;
export type ReservationId = Branded<string, 'ReservationId'>;

// === Factory Functions (use at system boundaries: Prisma results, REST params, UUID generation) ===
export const asPositionId = (raw: string): PositionId => raw as PositionId;
export const asOrderId = (raw: string): OrderId => raw as OrderId;
export const asPairId = (raw: string): PairId => raw as PairId;
export const asMatchId = (raw: string): MatchId => raw as MatchId;
export const asContractId = (raw: string): ContractId => raw as ContractId;
export const asOpportunityId = (raw: string): OpportunityId =>
  raw as OpportunityId;
export const asReservationId = (raw: string): ReservationId =>
  raw as ReservationId;

/**
 * Unwrap a branded ID back to a plain string.
 * Use when passing to external systems (Prisma queries, API responses, logs).
 * In practice, branded types ARE strings at runtime, so this is a no-op cast.
 */
export const unwrapId = <T extends Branded<string, string>>(id: T): string =>
  id as unknown as string;
