/**
 * Backfill script: Populate polymarketClobTokenId on ContractMatch records.
 *
 * Root cause: External pair ingestion (Predexon) did not resolve
 * polymarketClobTokenId during enrichment. This field is critical for
 * order book fetches and trade execution on Polymarket.
 *
 * This script fetches the Polymarket Gamma API catalog and updates
 * ContractMatch records by matching on polymarketContractId (= conditionId).
 *
 * Usage: npx tsx prisma/seed-backfill-clob-token-ids.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const GAMMA_API_URL =
  process.env.POLYMARKET_GAMMA_API_URL ??
  'https://gamma-api.polymarket.com';
const PAGE_LIMIT = 100;
const PAGE_DELAY_MS = 200;

interface GammaMarket {
  conditionId: string;
  clobTokenIds: string; // JSON array string
}

interface GammaEvent {
  markets?: GammaMarket[];
}

async function fetchPolymarketCatalog(): Promise<Map<string, string>> {
  const conditionToClobToken = new Map<string, string>();
  let offset = 0;
  let hasMore = true;

  console.log('Fetching Polymarket Gamma API catalog...');

  while (hasMore) {
    const url = `${GAMMA_API_URL}/events?active=true&closed=false&limit=${PAGE_LIMIT}&offset=${offset}`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Gamma API ${res.status}: ${url}`);
    }

    const events = (await res.json()) as GammaEvent[];

    for (const event of events) {
      if (!event.markets?.length) continue;
      for (const market of event.markets) {
        try {
          const clobTokenIds = JSON.parse(market.clobTokenIds) as string[];
          if (clobTokenIds[0]) {
            conditionToClobToken.set(market.conditionId, clobTokenIds[0]);
          }
        } catch {
          // Skip unparseable clobTokenIds
        }
      }
    }

    hasMore = events.length >= PAGE_LIMIT;
    offset += events.length;

    if (hasMore) {
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }

    console.log(
      `Fetched ${offset} events, ${conditionToClobToken.size} markets with clobTokenIds...`,
    );
  }

  return conditionToClobToken;
}

async function main(): Promise<void> {
  const conditionToClobToken = await fetchPolymarketCatalog();
  console.log(
    `Total Polymarket markets with clobTokenIds: ${conditionToClobToken.size}`,
  );

  const affectedMatches = await prisma.contractMatch.findMany({
    where: { polymarketClobTokenId: null },
    select: { matchId: true, polymarketContractId: true },
  });

  console.log(
    `Found ${affectedMatches.length} ContractMatch records with null polymarketClobTokenId`,
  );

  let updated = 0;
  let skipped = 0;

  for (const match of affectedMatches) {
    const clobTokenId = conditionToClobToken.get(
      match.polymarketContractId,
    );

    if (clobTokenId) {
      await prisma.contractMatch.update({
        where: { matchId: match.matchId },
        data: { polymarketClobTokenId: clobTokenId },
      });
      updated++;
    } else {
      skipped++;
    }
  }

  console.log(
    `Backfill complete: ${updated} updated, ${skipped} skipped (conditionId not in active Polymarket catalog)`,
  );
}

main()
  .catch((e) => {
    console.error('Backfill failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
