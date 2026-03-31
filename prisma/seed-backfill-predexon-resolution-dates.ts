/**
 * Backfill script: Populate resolutionDate on Predexon-sourced ContractMatch records.
 *
 * Root cause: PredexonMatchingService was not mapping `earliest_expiration_ts` to
 * `ExternalMatchedPair.settlementDate`, so all Predexon matches were persisted with
 * null resolutionDate.
 *
 * This script re-fetches pairs from the Predexon API and updates matching
 * ContractMatch records with the correct resolution date.
 *
 * Usage: npx tsx prisma/seed-backfill-predexon-resolution-dates.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PREDEXON_API_KEY = process.env.PREDEXON_API_KEY ?? '';
const PREDEXON_BASE_URL =
  process.env.PREDEXON_BASE_URL ?? 'https://api.predexon.com';
const PAGE_SIZE = 100;
const RATE_LIMIT_MS = 72;

interface PredexonApiPair {
  POLYMARKET?: { condition_id?: string; expiration_ts?: number };
  KALSHI?: { market_ticker?: string; expiration_ts?: number };
  earliest_expiration_ts?: number;
}

interface PredexonApiResponse {
  pairs: PredexonApiPair[];
  pagination: { has_more: boolean; pagination_key?: string };
}

async function fetchAllPredexonPairs(): Promise<PredexonApiPair[]> {
  const allPairs: PredexonApiPair[] = [];
  let paginationKey: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (paginationKey) params.set('pagination_key', paginationKey);

    const url = `${PREDEXON_BASE_URL}/v2/matching-markets/pairs?${params.toString()}`;

    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));

    const res = await fetch(url, {
      headers: { 'x-api-key': PREDEXON_API_KEY },
    });

    if (!res.ok) {
      if (res.status === 403) {
        console.warn('Predexon 403 — Dev tier not active. Aborting.');
        break;
      }
      throw new Error(`Predexon API ${res.status}: ${url}`);
    }

    const data = (await res.json()) as PredexonApiResponse;
    allPairs.push(...data.pairs);
    hasMore = data.pagination.has_more;
    paginationKey = data.pagination.pagination_key;

    console.log(`Fetched ${allPairs.length} pairs so far...`);
  }

  return allPairs;
}

async function main(): Promise<void> {
  console.log('Fetching Predexon pairs...');
  const pairs = await fetchAllPredexonPairs();
  console.log(`Total Predexon pairs fetched: ${pairs.length}`);

  // Find Predexon-origin matches with null resolutionDate
  const affectedMatches = await prisma.contractMatch.findMany({
    where: { origin: 'PREDEXON', resolutionDate: null },
    select: {
      matchId: true,
      polymarketContractId: true,
      kalshiContractId: true,
    },
  });

  console.log(
    `Found ${affectedMatches.length} Predexon matches with null resolutionDate`,
  );

  // Build lookup map: "conditionId|ticker" → expirationTs
  const expirationMap = new Map<string, Date>();
  for (const pair of pairs) {
    const conditionId = pair.POLYMARKET?.condition_id;
    const ticker = pair.KALSHI?.market_ticker;
    const ts =
      pair.earliest_expiration_ts ??
      pair.POLYMARKET?.expiration_ts ??
      pair.KALSHI?.expiration_ts;

    if (conditionId && ticker && ts) {
      expirationMap.set(`${conditionId}|${ticker}`, new Date(ts * 1000));
    }
  }

  let updated = 0;
  let skipped = 0;

  for (const match of affectedMatches) {
    const key = `${match.polymarketContractId}|${match.kalshiContractId}`;
    const resolutionDate = expirationMap.get(key);

    if (resolutionDate) {
      await prisma.contractMatch.update({
        where: { matchId: match.matchId },
        data: { resolutionDate },
      });
      updated++;
    } else {
      skipped++;
    }
  }

  console.log(
    `Backfill complete: ${updated} updated, ${skipped} skipped (no Predexon match found)`,
  );
}

main()
  .catch((e) => {
    console.error('Backfill failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
