/**
 * RecallBricks Agent Runtime - Agent State Types
 *
 * Core schema for tracking agent operational state.
 * NOT user conversation data — this tracks what the agent attempted,
 * why, what succeeded/failed, constraints discovered, and current system state.
 */

// ============================================================================
// Agent State Entry
// ============================================================================

export type AgentStateOutcome =
  | 'success'
  | 'failure'
  | 'partial'
  | 'overridden'
  | 'deferred';

export interface AgentStateEntry {
  id: string;
  agent_id: string;
  timestamp: string;

  // What was happening
  goal: string;
  action: string;
  reasoning: string;

  // What happened
  outcome: AgentStateOutcome;
  result_summary: string;

  // What we learned
  lesson: string | null;
  constraint_discovered: string | null;

  // System state
  state_before: Record<string, unknown>;
  state_after: Record<string, unknown>;

  // Directives
  override: string | null;
  recommendation: string | null;

  // Metadata
  confidence: number;
  superseded_by: string | null;
  active: boolean;
}

// ============================================================================
// API Request/Response types for state endpoints
// ============================================================================

export interface SaveStateRequest {
  entry: Omit<AgentStateEntry, 'id'>;
}

export interface SaveStateResponse {
  id: string;
  created_at: string;
}

export interface GetAgentStateRequest {
  agent_id: string;
  active_only?: boolean;
  outcome?: AgentStateOutcome;
  limit?: number;
}

export interface GetAgentStateResponse {
  entries: AgentStateEntry[];
  total: number;
}

export interface ExplainRequest {
  agent_id: string;
  goal?: string;
}

export interface ExplainResponse {
  trace: string;
  entries_used: number;
}

// ============================================================================
// State context formatted for system prompt injection
// ============================================================================

export interface AgentOperationalState {
  activeGoals: string[];
  activeConstraints: string[];
  recentFailures: Array<{
    goal: string;
    action: string;
    result_summary: string;
    lesson: string | null;
  }>;
  directives: Array<{
    type: 'override' | 'recommendation';
    content: string;
  }>;
  currentState: Record<string, unknown>;
}
