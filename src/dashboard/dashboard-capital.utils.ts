import Decimal from 'decimal.js';

/**
 * Pure function: computes bankroll, deployed, available, reserved from a
 * bankroll string and an optional risk-state record.
 *
 * Shared by DashboardOverviewService and DashboardCapitalService to
 * eliminate duplication (Story 10-8-4 CR fix P1).
 */
export function computeModeCapital(
  bankrollStr: string,
  riskState?: {
    totalCapitalDeployed: { toString(): string };
    reservedCapital: { toString(): string };
  } | null,
): {
  bankroll: string | null;
  deployed: string | null;
  available: string | null;
  reserved: string | null;
} {
  const bankroll = new Decimal(bankrollStr);
  const deployed = riskState?.totalCapitalDeployed
    ? new Decimal(riskState.totalCapitalDeployed.toString())
    : new Decimal(0);
  const reserved = riskState?.reservedCapital
    ? new Decimal(riskState.reservedCapital.toString())
    : new Decimal(0);
  const available = Decimal.max(
    bankroll.minus(deployed).minus(reserved),
    new Decimal(0),
  );
  return {
    bankroll: bankroll.toString(),
    deployed: deployed.toString(),
    available: available.toString(),
    reserved: reserved.toString(),
  };
}
