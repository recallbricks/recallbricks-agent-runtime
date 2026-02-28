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
// Constraint Types
// ============================================================================

export type ConstraintMode = 'observe' | 'enforce';
export type ConstraintMatchType = 'contains' | 'regex' | 'tool_name' | 'exact';

export interface Constraint {
  id: string;
  agent_id: string;
  constraint_text: string;
  mode: ConstraintMode;
  match_pattern: string | null;
  match_type: ConstraintMatchType;
  scope: string;
  active: boolean;
  source: string | null;
  source_state_id: string | null;
  times_triggered: number;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateConstraintRequest {
  agent_id: string;
  constraint_text: string;
  mode?: ConstraintMode;
  match_pattern?: string;
  match_type?: ConstraintMatchType;
  scope?: string;
}

export interface UpdateConstraintRequest {
  mode?: ConstraintMode;
  active?: boolean;
  match_pattern?: string;
}

export interface ConstraintViolation {
  constraint_id: string;
  constraint_text: string;
  decision: 'blocked' | 'warned';
  mode: ConstraintMode;
}

export interface ConstraintCheckResult {
  allowed: boolean;
  violations: ConstraintViolation[];
}

export interface EnforcementLogEntry {
  id: string;
  agent_id: string;
  constraint_id: string;
  proposed_action: string;
  decision: 'blocked' | 'warned';
  constraint_text: string;
  created_at: string;
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
