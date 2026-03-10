/**
 * Story 8.6 — Before/after analysis of candidate filtering fixes.
 *
 * Connects to the database, fetches all ContractMatch records, re-computes
 * TF-IDF pre-filter scores using PreFilterService logic, and outputs a CSV
 * showing which matches survive the B0+B1 (null date) and B2 (threshold) filters.
 *
 * Usage:
 *   npx tsx scripts/analyze-matches.ts [threshold]
 *
 * Default threshold: 0.30 (starting hypothesis from sprint-change-proposal).
 * The script tests multiple thresholds and outputs survival counts for each.
 */

import { PrismaClient } from '@prisma/client';
import { PreFilterService } from '../src/modules/contract-matching/pre-filter.service';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

interface MatchRow {
  matchId: string;
  polymarketTitle: string;
  kalshiTitle: string;
  tfidfPreFilterScore: number;
  llmConfidenceScore: number | null;
  resolutionDate: string;
  survivesB0B1: boolean;
  survivesB2: boolean;
  survivesAll: boolean;
}

async function main() {
  const prisma = new PrismaClient();
  const preFilter = new PreFilterService();

  try {
    const matches = await prisma.contractMatch.findMany({
      orderBy: { createdAt: 'asc' },
    });

    console.log(`Fetched ${matches.length} ContractMatch records.\n`);

    const thresholdArg = process.argv[2];
    const chosenThreshold = thresholdArg ? parseFloat(thresholdArg) : 0.25;
    const thresholds = [0.15, 0.2, 0.25, 0.27, 0.28, 0.29, 0.3, 0.35];

    const rows: MatchRow[] = [];

    for (const match of matches) {
      const polyDesc = match.polymarketDescription ?? '';
      const kalshiDesc = match.kalshiDescription ?? '';

      // Re-compute TF-IDF combined score using current PreFilterService algorithm
      const similarity = preFilter.computeSimilarity(polyDesc, kalshiDesc);

      const resolutionDate = match.resolutionDate
        ? match.resolutionDate.toISOString()
        : '';

      // B0+B1: matches without a resolution date would have been excluded
      const survivesB0B1 = !!match.resolutionDate;

      // B2: survives the chosen threshold
      const survivesB2 = similarity.combinedScore >= chosenThreshold;

      rows.push({
        matchId: match.matchId,
        polymarketTitle: (polyDesc.split('\n')[0] ?? '').slice(0, 100),
        kalshiTitle: (kalshiDesc.split('\n')[0] ?? '').slice(0, 100),
        tfidfPreFilterScore: Math.round(similarity.combinedScore * 1000) / 1000,
        llmConfidenceScore: match.confidenceScore,
        resolutionDate,
        survivesB0B1,
        survivesB2,
        survivesAll: survivesB0B1 && survivesB2,
      });
    }

    // Output threshold comparison table
    console.log('=== Threshold Comparison ===\n');
    console.log(
      'Threshold | Total | SurviveB0B1 | SurviveB2 | SurviveAll | Legitimate(40-55) surviving',
    );
    console.log(
      '----------|-------|-------------|-----------|------------|---------------------------',
    );

    for (const t of thresholds) {
      const surviveB0B1 = rows.filter((r) => r.survivesB0B1).length;
      const surviveB2 = rows.filter((r) => r.tfidfPreFilterScore >= t).length;
      const surviveAll = rows.filter(
        (r) => r.survivesB0B1 && r.tfidfPreFilterScore >= t,
      ).length;
      const legitimate = rows.filter(
        (r) =>
          r.llmConfidenceScore !== null &&
          r.llmConfidenceScore >= 40 &&
          r.llmConfidenceScore <= 55 &&
          r.survivesB0B1 &&
          r.tfidfPreFilterScore >= t,
      ).length;

      console.log(
        `${t.toFixed(2).padStart(9)} | ${String(rows.length).padStart(5)} | ${String(surviveB0B1).padStart(11)} | ${String(surviveB2).padStart(9)} | ${String(surviveAll).padStart(10)} | ${legitimate}/4`,
      );
    }

    // Generate CSV with the chosen threshold
    const csvHeader =
      'matchId,polymarketTitle,kalshiTitle,tfidfPreFilterScore,llmConfidenceScore,resolutionDate,survivesB0B1,survivesB2,survivesAll';

    const csvRows = rows.map((r) => {
      const escapeCsv = (s: string) =>
        s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"`
          : s;

      return [
        r.matchId,
        escapeCsv(r.polymarketTitle),
        escapeCsv(r.kalshiTitle),
        r.tfidfPreFilterScore,
        r.llmConfidenceScore ?? '',
        r.resolutionDate,
        r.survivesB0B1,
        r.survivesB2,
        r.survivesAll,
      ].join(',');
    });

    const csvContent = [csvHeader, ...csvRows].join('\n') + '\n';
    const csvPath = resolve(
      __dirname,
      '../docs/analysis/8-6-candidate-filter-before-after.csv',
    );
    writeFileSync(csvPath, csvContent, 'utf-8');

    console.log(`\nCSV written to: ${csvPath}`);
    console.log(`Chosen threshold for CSV: ${chosenThreshold}`);

    // Identify the 4 legitimate matches
    const legitimate = rows.filter(
      (r) =>
        r.llmConfidenceScore !== null &&
        r.llmConfidenceScore >= 40 &&
        r.llmConfidenceScore <= 55,
    );
    console.log(
      `\n=== Legitimate matches (score 40-55): ${legitimate.length} ===`,
    );
    for (const m of legitimate) {
      console.log(
        `  ${m.llmConfidenceScore} | TF-IDF: ${m.tfidfPreFilterScore} | B0B1: ${m.survivesB0B1} | B2: ${m.survivesB2} | ${m.polymarketTitle.slice(0, 60)}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
