import { Injectable, Inject, Logger } from '@nestjs/common';
import type { ContractSummary } from '../../common/interfaces/contract-catalog-provider.interface.js';
import {
  SCORING_STRATEGY_TOKEN,
  type IScoringStrategy,
} from '../../common/interfaces/scoring-strategy.interface.js';
import { LLM_ALIGNMENT_THRESHOLD } from '../../common/constants/matching-thresholds.js';

export interface DirectionValidationResult {
  aligned: boolean | null;
  correctedTokenId?: string;
  correctedLabel?: string;
  reason: string;
}

const COMMON_SUFFIXES = /\s+(wins|will win|to win)$/i;
const MIN_NAME_LENGTH = 4;

function normalize(label: string): string {
  return label
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(COMMON_SUFFIXES, '')
    .trim();
}

@Injectable()
export class OutcomeDirectionValidator {
  private readonly logger = new Logger(OutcomeDirectionValidator.name);

  constructor(
    @Inject(SCORING_STRATEGY_TOKEN)
    private readonly scoringStrategy: IScoringStrategy,
  ) {}

  async validateDirection(
    polyContract: ContractSummary,
    kalshiContract: ContractSummary,
  ): Promise<DirectionValidationResult> {
    const polyLabel = polyContract.outcomeLabel;
    const kalshiLabel = kalshiContract.outcomeLabel;

    if (!polyLabel || !kalshiLabel) {
      return {
        aligned: null,
        reason: `Outcome label missing (poly: ${polyLabel ?? 'none'}, kalshi: ${kalshiLabel ?? 'none'})`,
      };
    }

    const polyNorm = normalize(polyLabel);
    const kalshiNorm = normalize(kalshiLabel);

    // Direct match after normalization
    if (polyNorm === kalshiNorm) {
      return {
        aligned: true,
        reason: `Substring match: "${polyNorm}" === "${kalshiNorm}"`,
      };
    }

    // Substring containment check (only if shorter name >= MIN_NAME_LENGTH)
    const shorter =
      polyNorm.length <= kalshiNorm.length ? polyNorm : kalshiNorm;
    const longer = polyNorm.length <= kalshiNorm.length ? kalshiNorm : polyNorm;

    if (shorter.length >= MIN_NAME_LENGTH) {
      if (longer.includes(shorter)) {
        return {
          aligned: true,
          reason: `Substring match: "${shorter}" found in "${longer}"`,
        };
      }

      // Check if any Polymarket outcome token aligns with Kalshi label
      // before concluding mismatch (self-correction attempt)
      return this.attemptSelfCorrection(
        polyContract,
        kalshiContract,
        kalshiNorm,
      );
    }

    // Short names — delegate to LLM
    return this.llmCompare(
      polyContract,
      kalshiContract,
      polyLabel,
      kalshiLabel,
    );
  }

  private async attemptSelfCorrection(
    polyContract: ContractSummary,
    kalshiContract: ContractSummary,
    kalshiNorm: string,
  ): Promise<DirectionValidationResult> {
    const tokens = polyContract.outcomeTokens;
    if (!tokens?.length) {
      // No tokens to search — use LLM as fallback
      return this.llmCompare(
        polyContract,
        kalshiContract,
        polyContract.outcomeLabel!,
        kalshiContract.outcomeLabel!,
      );
    }

    // Try substring match against each token
    for (const token of tokens) {
      const tokenNorm = normalize(token.outcomeLabel);
      if (tokenNorm === kalshiNorm) {
        return {
          aligned: true,
          correctedTokenId: token.tokenId,
          correctedLabel: token.outcomeLabel,
          reason: `Self-corrected: swapped to "${token.outcomeLabel}" (token ${token.tokenId})`,
        };
      }

      const shorter =
        tokenNorm.length <= kalshiNorm.length ? tokenNorm : kalshiNorm;
      const longer =
        tokenNorm.length <= kalshiNorm.length ? kalshiNorm : tokenNorm;

      if (shorter.length >= MIN_NAME_LENGTH && longer.includes(shorter)) {
        return {
          aligned: true,
          correctedTokenId: token.tokenId,
          correctedLabel: token.outcomeLabel,
          reason: `Self-corrected: swapped to "${token.outcomeLabel}" (token ${token.tokenId})`,
        };
      }
    }

    // No substring match found — try LLM for each token
    for (const token of tokens) {
      const llmResult = await this.llmCompare(
        { ...polyContract, outcomeLabel: token.outcomeLabel },
        kalshiContract,
        token.outcomeLabel,
        kalshiContract.outcomeLabel!,
      );
      if (llmResult.aligned === true) {
        return {
          aligned: true,
          correctedTokenId: token.tokenId,
          correctedLabel: token.outcomeLabel,
          reason: `Self-corrected via LLM: swapped to "${token.outcomeLabel}" (token ${token.tokenId})`,
        };
      }
    }

    return {
      aligned: false,
      reason: `No aligning token found in outcomeTokens for Kalshi label "${kalshiContract.outcomeLabel}"`,
    };
  }

  private async llmCompare(
    polyContract: ContractSummary,
    kalshiContract: ContractSummary,
    polyLabel: string,
    kalshiLabel: string,
  ): Promise<DirectionValidationResult> {
    try {
      const result = await this.scoringStrategy.scoreMatch(
        `Outcome: ${polyLabel}. Context: ${polyContract.description}`,
        `Outcome: ${kalshiLabel}. Context: ${kalshiContract.description}`,
      );

      if (result.score >= LLM_ALIGNMENT_THRESHOLD) {
        return {
          aligned: true,
          reason: `LLM alignment confirmed (score: ${result.score})`,
        };
      }

      return {
        aligned: false,
        reason: `LLM determined mismatch (score: ${result.score})`,
      };
    } catch (error) {
      this.logger.warn({
        message: 'LLM direction comparison failed, treating as inconclusive',
        data: {
          polyLabel,
          kalshiLabel,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return {
        aligned: null,
        reason: `LLM comparison failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
