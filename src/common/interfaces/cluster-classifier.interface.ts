import type { ClusterId, MatchId } from '../types/branded.type.js';
import type { ClusterAssignment } from '../types/risk.type.js';

export const CLUSTER_CLASSIFIER_TOKEN = 'IClusterClassifier';

export interface IClusterClassifier {
  /**
   * Classify a contract match into a correlation cluster.
   * Uses deterministic fast-path (ClusterTagMapping lookup) first;
   * falls back to LLM classification for unknown categories.
   */
  classifyMatch(
    polyCategory: string | null,
    kalshiCategory: string | null,
    polyDescription: string,
    kalshiDescription: string,
  ): Promise<ClusterAssignment>;

  /**
   * Get or create a correlation cluster by name.
   * Returns existing cluster's ID if name matches (case-insensitive slug match).
   */
  getOrCreateCluster(name: string, description?: string): Promise<ClusterId>;

  /**
   * Reassign a contract match to a different cluster (operator override).
   * Updates ContractMatch.clusterId and logs to audit trail.
   * Contract-matching module owns all ContractMatch writes.
   */
  reassignCluster(
    matchId: MatchId,
    newClusterId: ClusterId,
    rationale: string,
  ): Promise<{ oldClusterId: ClusterId | null; newClusterId: ClusterId }>;
}
