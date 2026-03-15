/**
 * RecallBricks Agent Runtime - Core Types
 *
 * Type definitions for the universal cognitive runtime
 */

import type { ConstraintViolation } from './AgentState';

// ============================================================================
// LLM Provider Types
// ============================================================================

export type LLMProvider = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'cohere' | 'local';

export type RecallBricksTier = 'starter' | 'professional' | 'enterprise';

export type CaptureMode = 'off' | 'tools' | 'auto';

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMResponse {
  content: string;
  provider: LLMProvider;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
}

// ============================================================================
// Agent Identity Types
// ============================================================================

export interface AgentIdentity {
  id: string;
  name: string;
  purpose: string;
  traits: string[];
  rules: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentBehavioralRule {
  rule: string;
  priority: number;
  enforced: boolean;
}

// ============================================================================
// Memory and Context Types
// ============================================================================

export interface Memory {
  id: string;
  content: string;
  type: 'conversation' | 'fact' | 'observation' | 'insight';
  importance: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface MemoryContext {
  recentMemories: Memory[];
  relevantMemories: Memory[];
  predictedContext: string[];
  totalMemories: number;
  lastUpdated: string;
}

export interface ConversationTurn {
  userMessage: string;
  assistantResponse: string;
  timestamp: string;
  importance?: number;
}

// ============================================================================
// Runtime Configuration Types
// ============================================================================

export interface RuntimeConfig {
  agentId: string;
  userId: string;
  agentName?: string;
  agentPurpose?: string;
  apiUrl?: string;
  apiKey?: string;
  llmConfig?: LLMConfig;
  tier?: RecallBricksTier;
  autoSave?: boolean;
  validateIdentity?: boolean;
  cacheEnabled?: boolean;
  cacheTTL?: number;
  maxContextTokens?: number;
  debug?: boolean;
  mcpMode?: boolean;
  registerAgent?: boolean;
  allowedTools?: string[];
  agentVersion?: string;
  captureMode?: CaptureMode;
}

export interface RuntimeOptions {
  agentId: string;
  userId: string;
  agentName?: string;
  agentPurpose?: string;
  apiUrl?: string;
  apiKey?: string;
  llmProvider?: LLMProvider;
  llmApiKey?: string;
  llmModel?: string;
  tier?: RecallBricksTier;
  autoSave?: boolean;
  validateIdentity?: boolean;
  cacheEnabled?: boolean;
  cacheTTL?: number;
  maxContextTokens?: number;
  debug?: boolean;
  mcpMode?: boolean;
  registerAgent?: boolean;
  allowedTools?: string[];
  agentVersion?: string;
  captureMode?: CaptureMode;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface SaveConversationRequest {
  agentId: string;
  userId: string;
  userMessage: string;
  assistantResponse: string;
  importance?: number;
  metadata?: Record<string, unknown>;
}

export interface SaveConversationResponse {
  success: boolean;
  memoryId?: string;
  importance?: number;
  message?: string;
}

export interface GetContextRequest {
  agentId: string;
  userId: string;
  limit?: number;
  includeRelevant?: boolean;
  includePredicted?: boolean;
}

export interface GetContextResponse {
  identity: AgentIdentity;
  context: MemoryContext;
}

export interface GetIdentityRequest {
  agentId: string;
}

export interface GetIdentityResponse {
  identity: AgentIdentity;
}

// ============================================================================
// Identity Validation Types
// ============================================================================

export interface IdentityViolation {
  type: 'base_model_reference' | 'inconsistent_behavior' | 'identity_leak';
  detected: string;
  suggestion: string;
  severity: 'low' | 'medium' | 'high';
}

export interface ValidationResult {
  isValid: boolean;
  violations: IdentityViolation[];
  correctedResponse?: string;
}

// ============================================================================
// Auto-Save Classification Types
// ============================================================================

export interface ImportanceClassification {
  importance: number;
  reasoning: string;
  model: string;
}

export interface SaveMetadata {
  classified: boolean;
  importance: number;
  isDuplicate: boolean;
  timestamp: string;
}

// ============================================================================
// Context Loading Types
// ============================================================================

export interface ContextPrompt {
  systemPrompt: string;
  identitySection: string;
  memorySection: string;
  rulesSection: string;
}

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

// ============================================================================
// Error Types
// ============================================================================

export class RecallBricksError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public details?: unknown
  ) {
    super(message);
    this.name = 'RecallBricksError';
  }
}

export class APIError extends RecallBricksError {
  constructor(message: string, statusCode: number, details?: unknown) {
    super(message, 'API_ERROR', statusCode, details);
    this.name = 'APIError';
  }
}

export class ConfigurationError extends RecallBricksError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFIGURATION_ERROR', undefined, details);
    this.name = 'ConfigurationError';
  }
}

export class LLMError extends RecallBricksError {
  constructor(message: string, provider: LLMProvider, details?: unknown) {
    super(message, 'LLM_ERROR', undefined, {
      provider,
      ...(details && typeof details === 'object' ? details as Record<string, unknown> : {})
    });
    this.name = 'LLMError';
  }
}

// ============================================================================
// Logging Types
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

// ============================================================================
// Adapter Types
// ============================================================================

export interface ChatRequest {
  message: string;
  conversationHistory?: LLMMessage[];
  streamResponse?: boolean;
}

export interface ChatResponse {
  response: string;
  metadata: {
    provider: LLMProvider;
    model: string;
    contextLoaded: boolean;
    identityValidated: boolean;
    autoSaved: boolean;
    tokensUsed?: number;
    constraintViolations?: ConstraintViolation[];
    recoveredFromBlock?: boolean;
  };
}

// ============================================================================
// Circuit Breaker Types
// ============================================================================

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeout: number;
  monitorInterval: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  lastFailureTime?: number;
  nextRetryTime?: number;
}

// ============================================================================
// RecallBricks API v1 Types
// ============================================================================

/**
 * Response from /api/v1/memories/save endpoint
 * API handles tier upgrades automatically based on retrieval count:
 * - Tier 1: Basic storage (no enrichment)
 * - Tier 2: Auto-enriched after 2+ retrievals (Haiku in background)
 * - Tier 3: Deep analysis after 5+ retrievals (Sonnet in background)
 */
export interface SaveResponse {
  id: string;
  text: string;
  user_id: string;
  metadata?: {
    tags?: string[];
    category?: string;
    importance?: number;
    source?: string;
  };
  created_at: string;
}

/**
 * @deprecated Use SaveResponse instead - /api/v1/memories/learn is deprecated
 */
export interface LearnResponse {
  id: string;
  text: string;
  metadata: {
    tags: string[];
    category: string;
    entities: string[];
    importance: number;
    summary: string;
  };
  created_at: string;
}

/**
 * Memory returned from recall endpoint
 */
export interface RecallMemory {
  id: string;
  text: string;
  score: number;
  metadata: {
    tags: string[];
    category: string;
    importance: number;
    summary: string;
  };
  created_at: string;
}

/**
 * Category summary in organized recall response
 */
export interface CategorySummary {
  count: number;
  avg_score: number;
  summary: string;
}

/**
 * Response from /api/v1/memories/recall endpoint
 */
export interface RecallResponse {
  memories: RecallMemory[];
  categories?: Record<string, CategorySummary>;
  total: number;
}

// ============================================================================
// Autonomous Agent Types
// ============================================================================

/**
 * Working memory entry for temporary task state
 */
export interface WorkingMemoryEntry {
  key: string;
  value: unknown;
  timestamp: string;
  expiresAt?: string;
}

/**
 * Working memory session for autonomous agents
 */
export interface WorkingMemorySession {
  sessionId: string;
  agentId: string;
  createdAt: string;
  entries: WorkingMemoryEntry[];
  addEntry(key: string, value: unknown, ttl?: number): Promise<WorkingMemoryEntry>;
  getEntry(key: string): Promise<WorkingMemoryEntry | undefined>;
  removeEntry(key: string): Promise<boolean>;
  clear(): Promise<void>;
  persist(): Promise<void>;
}

/**
 * Client for working memory operations
 */
export interface WorkingMemoryClient {
  createSession(sessionId: string): Promise<WorkingMemorySession>;
  getSession(sessionId: string): Promise<WorkingMemorySession | undefined>;
  listSessions(): Promise<string[]>;
}

/**
 * Goal step status
 */
export type GoalStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Goal overall status
 */
export type GoalStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

/**
 * Individual step in a goal
 */
export interface GoalStep {
  stepNumber: number;
  description: string;
  status: GoalStepStatus;
  completedAt?: string;
  failureReason?: string;
}

/**
 * Result of tracking a goal
 */
export interface GoalTrackingResult {
  goalId: string;
  steps: GoalStep[];
  status: GoalStatus;
  startedAt: string;
  completedAt?: string;
  progress: number;
  completeStep(stepNumber: number): Promise<void>;
  failStep(stepNumber: number, reason: string): Promise<void>;
}

/**
 * Client for goal tracking operations
 */
export interface GoalsClient {
  trackGoal(goalId: string, steps: string[]): Promise<GoalTrackingResult>;
  getGoal(goalId: string): Promise<GoalTrackingResult | undefined>;
  listGoals(): Promise<GoalTrackingResult[]>;
  cancelGoal(goalId: string): Promise<boolean>;
}

/**
 * Metacognition assessment result
 */
export interface MetacognitionAssessment {
  timestamp: string;
  response: string;
  confidence: number;
  needsReflection: boolean;
  suggestions: string[];
}

/**
 * Client for metacognition operations
 */
export interface MetacognitionClient {
  assessResponse(response: string, confidence: number): Promise<MetacognitionAssessment>;
  getAssessmentHistory(): Promise<MetacognitionAssessment[]>;
  getAverageConfidence(): Promise<number>;
  triggerReflection(): Promise<void>;
}

// ============================================================================
// Re-export Agent State Types
// ============================================================================

export type {
  AgentStateOutcome,
  AgentStateEntry,
  SaveStateRequest,
  SaveStateResponse,
  GetAgentStateRequest,
  GetAgentStateResponse,
  ExplainRequest,
  ExplainResponse,
  AgentOperationalState,
  ConstraintMode,
  ConstraintMatchType,
  Constraint,
  CreateConstraintRequest,
  UpdateConstraintRequest,
  ConstraintViolation,
  ConstraintCheckResult,
  EnforcementLogEntry,
} from './AgentState';
