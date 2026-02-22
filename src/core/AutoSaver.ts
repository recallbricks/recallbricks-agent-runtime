/**
 * RecallBricks Agent Runtime - Auto Saver
 *
 * Automatically saves conversation turns to the RecallBricks Memory API v1
 * AND extracts structured agent state entries using heuristics (no LLM calls).
 *
 * Uses POST /api/v1/memories endpoint (legacy)
 * Uses POST /api/v1/state endpoint (primary - agent state tracking)
 */

import axios, { AxiosInstance } from 'axios';
import pRetry from 'p-retry';
import {
  ConversationTurn,
  SaveConversationResponse,
  SaveResponse,
  RecallBricksTier,
  APIError,
  Logger,
  AgentStateEntry,
  AgentStateOutcome,
} from '../types';
import { RecallBricksClient } from '../api/RecallBricksClient';

// ============================================================================
// Auto Saver Configuration
// ============================================================================

interface AutoSaverConfig {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  userId: string;
  tier: RecallBricksTier;
  logger: Logger;
  apiClient?: RecallBricksClient;
}

// ============================================================================
// State Extraction Context
// ============================================================================

export interface StateExtractionContext {
  turnNumber: number;
  sessionGoals: string[];
  reflectionOutput?: string;
  toolsUsed?: Array<{ name: string; result?: string }>;
}

// ============================================================================
// Auto Saver Implementation
// ============================================================================
// Note: Tier-based enrichment is handled automatically by the RecallBricks API
// - Tier 1: Basic storage (no enrichment)
// - Tier 2: Auto-enriched after 2+ retrievals (Haiku in background)
// - Tier 3: Deep analysis after 5+ retrievals (Sonnet in background)

export class AutoSaver {
  private apiClient: AxiosInstance;
  private rbClient?: RecallBricksClient;
  private saveQueue: Array<{
    turn: ConversationTurn;
    resolve: (value: boolean) => void;
    reject: (error: Error) => void;
  }> = [];
  private isProcessing = false;

  // State tracking
  private stateEntries: AgentStateEntry[] = [];
  private extractionContext: StateExtractionContext = {
    turnNumber: 0,
    sessionGoals: [],
  };

  constructor(private config: AutoSaverConfig) {
    this.rbClient = config.apiClient;

    this.apiClient = axios.create({
      baseURL: config.apiUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey,
      },
    });

    config.logger.debug('AutoSaver initialized', {
      tier: config.tier,
      apiUrl: config.apiUrl,
    });
  }

  /**
   * Save a conversation turn (non-blocking)
   * Now also extracts and saves agent state entry
   */
  async save(turn: ConversationTurn): Promise<boolean> {
    this.config.logger.debug('Queuing conversation turn for save', {
      timestamp: turn.timestamp,
    });

    return new Promise((resolve, reject) => {
      this.saveQueue.push({ turn, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Save a conversation turn synchronously (blocking)
   * Legacy: saves as text memory
   */
  async saveSync(turn: ConversationTurn): Promise<SaveConversationResponse> {
    this.config.logger.debug('Saving conversation turn synchronously');

    const importance = turn.importance ?? (await this.classifyImportance(turn));

    // Format conversation as single text string for the save endpoint
    const conversationText = `User: ${turn.userMessage}
Assistant: ${turn.assistantResponse}`;

    try {
      const response = await pRetry(
        async () => {
          // Use /api/v1/memories endpoint
          // API handles tier upgrades automatically based on retrieval count
          const result = await this.apiClient.post<SaveResponse>(
            '/api/v1/memories',
            {
              text: conversationText,
              source: 'agent-runtime',
              metadata: {
                importance: importance,
                agent_id: this.config.agentId,
                timestamp: turn.timestamp,
              },
            }
          );
          return result.data;
        },
        {
          retries: 3,
          minTimeout: 1000,
          onFailedAttempt: (error) => {
            this.config.logger.warn(
              `Save attempt ${error.attemptNumber} failed. ${error.retriesLeft} retries left.`
            );
          },
        }
      );

      this.config.logger.info('Conversation saved successfully', {
        memoryId: response.id,
        importance: response.metadata?.importance ?? importance,
      });

      return {
        success: true,
        memoryId: response.id,
        importance: response.metadata?.importance ?? importance,
      };
    } catch (error) {
      this.config.logger.error('Failed to save conversation', { error });
      throw this.handleAPIError(error);
    }
  }

  // ==========================================================================
  // Agent State Extraction (heuristic, no LLM calls)
  // ==========================================================================

  /**
   * Extract a structured state entry from a conversation turn.
   * Uses heuristics only — no LLM calls.
   */
  extractStateEntry(
    turn: ConversationTurn,
    context?: Partial<StateExtractionContext>
  ): AgentStateEntry {
    this.extractionContext.turnNumber++;
    if (context) {
      if (context.sessionGoals) this.extractionContext.sessionGoals = context.sessionGoals;
      if (context.reflectionOutput) this.extractionContext.reflectionOutput = context.reflectionOutput;
      if (context.toolsUsed) this.extractionContext.toolsUsed = context.toolsUsed;
    }

    const goal = this.extractGoal(turn);
    const action = this.extractAction(turn);
    const outcome = this.extractOutcome(turn);
    const reasoning = this.extractReasoning(turn);
    const confidence = this.calculateHeuristicImportance(turn);

    const entryId = `state_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Check if this supersedes a previous entry for the same goal
    const supersededEntry = this.findSupersededEntry(goal);

    const entry: AgentStateEntry = {
      id: entryId,
      agent_id: this.config.agentId,
      timestamp: turn.timestamp || new Date().toISOString(),
      goal,
      action,
      reasoning,
      outcome,
      result_summary: this.extractResultSummary(turn, outcome),
      lesson: this.extractLesson(turn),
      constraint_discovered: this.extractConstraint(turn),
      state_before: {
        turn_number: this.extractionContext.turnNumber - 1,
        active_goals: [...this.extractionContext.sessionGoals],
      },
      state_after: {
        turn_number: this.extractionContext.turnNumber,
        active_goals: this.updateGoals(goal, outcome),
      },
      override: null,
      recommendation: this.extractRecommendation(turn),
      confidence,
      superseded_by: null,
      active: true,
    };

    // Mark superseded entry as inactive
    if (supersededEntry) {
      supersededEntry.active = false;
      supersededEntry.superseded_by = entryId;
    }

    this.stateEntries.push(entry);
    return entry;
  }

  /**
   * Extract and save state entry in one step
   */
  async saveStateEntry(
    turn: ConversationTurn,
    context?: Partial<StateExtractionContext>
  ): Promise<AgentStateEntry> {
    const entry = this.extractStateEntry(turn, context);

    if (this.rbClient) {
      try {
        const { id: _id, ...entryWithoutId } = entry;
        const response = await this.rbClient.saveState(entryWithoutId);
        entry.id = response.id || entry.id;
        this.config.logger.info('Agent state entry saved', {
          id: entry.id,
          goal: entry.goal,
          outcome: entry.outcome,
        });
      } catch (error) {
        this.config.logger.warn('Failed to save state entry to API, kept locally', { error });
      }
    }

    return entry;
  }

  /**
   * Update extraction context (call before extracting)
   */
  updateExtractionContext(context: Partial<StateExtractionContext>): void {
    if (context.reflectionOutput !== undefined) {
      this.extractionContext.reflectionOutput = context.reflectionOutput;
    }
    if (context.toolsUsed !== undefined) {
      this.extractionContext.toolsUsed = context.toolsUsed;
    }
    if (context.sessionGoals !== undefined) {
      this.extractionContext.sessionGoals = context.sessionGoals;
    }
  }

  /**
   * Get all locally tracked state entries
   */
  getStateEntries(): AgentStateEntry[] {
    return [...this.stateEntries];
  }

  /**
   * Get active state entries only
   */
  getActiveStateEntries(): AgentStateEntry[] {
    return this.stateEntries.filter(e => e.active);
  }

  // ==========================================================================
  // Heuristic Extraction Methods
  // ==========================================================================

  private extractGoal(turn: ConversationTurn): string {
    const msg = turn.userMessage;

    // If tools were used, the goal is what was being accomplished
    if (this.extractionContext.toolsUsed?.length) {
      const toolNames = this.extractionContext.toolsUsed.map(t => t.name).join(', ');
      return `Execute: ${toolNames} — ${msg.slice(0, 100)}`;
    }

    // Extract imperative/request pattern
    const imperativeMatch = msg.match(
      /^(?:please\s+)?(?:can you\s+)?(?:help me\s+)?([\w\s]+?)(?:\?|$)/i
    );
    if (imperativeMatch && imperativeMatch[1].trim().length > 3) {
      return imperativeMatch[1].trim().slice(0, 120);
    }

    // Fallback: first 120 chars of user message as the goal
    return msg.slice(0, 120).trim() || 'respond to user input';
  }

  private extractAction(turn: ConversationTurn): string {
    // If tools were used, action = tool invocation
    if (this.extractionContext.toolsUsed?.length) {
      return this.extractionContext.toolsUsed
        .map(t => `tool:${t.name}`)
        .join(', ');
    }

    // Parse the response for action verbs
    const response = turn.assistantResponse;
    const actionVerbs = [
      'created', 'updated', 'deleted', 'searched', 'found', 'generated',
      'analyzed', 'computed', 'fetched', 'returned', 'explained', 'listed',
      'modified', 'executed', 'deployed', 'configured', 'installed',
    ];

    for (const verb of actionVerbs) {
      const match = response.match(new RegExp(`I\\s+${verb}\\s+([^.]{5,60})`, 'i'));
      if (match) {
        return `${verb} ${match[1].trim()}`;
      }
    }

    // Detect response type
    if (response.includes('```')) return 'provided code';
    if (response.match(/\d+\.\s/)) return 'provided list/steps';
    if (response.length > 800) return 'provided detailed explanation';

    return 'generated response';
  }

  private extractOutcome(turn: ConversationTurn): AgentStateOutcome {
    const response = turn.assistantResponse.toLowerCase();

    // Check for tool results
    if (this.extractionContext.toolsUsed?.length) {
      const hasFailure = this.extractionContext.toolsUsed.some(
        t => t.result && /error|fail|exception|denied/i.test(t.result)
      );
      if (hasFailure) return 'failure';
      return 'success';
    }

    // Error/failure indicators
    const failurePatterns = [
      /\b(?:error|failed|failure|cannot|unable|impossible)\b/,
      /\bi (?:can't|couldn't|wasn't able to|am unable to)\b/,
      /\bunfortunately\b/,
      /\bsorry,?\s+(?:i|but)\b/,
    ];
    for (const pattern of failurePatterns) {
      if (pattern.test(response)) return 'failure';
    }

    // Partial indicators
    const partialPatterns = [
      /\bhowever\b.*\bbut\b/,
      /\bpartially\b/,
      /\bsome (?:of|issues|limitations)\b/,
      /\bnot (?:fully|completely|entirely)\b/,
    ];
    for (const pattern of partialPatterns) {
      if (pattern.test(response)) return 'partial';
    }

    // Deferred indicators
    const deferredPatterns = [
      /\blater\b/,
      /\bneed more (?:info|information|context|details)\b/,
      /\bclarif(?:y|ication)\b/,
    ];
    for (const pattern of deferredPatterns) {
      if (pattern.test(response)) return 'deferred';
    }

    return 'success';
  }

  private extractReasoning(turn: ConversationTurn): string {
    // If reflection engine output is available, use it
    if (this.extractionContext.reflectionOutput) {
      return this.extractionContext.reflectionOutput.slice(0, 300);
    }

    // Look for reasoning phrases in the response
    const response = turn.assistantResponse;
    const reasoningPatterns = [
      /because\s+([^.]{10,100})/i,
      /the reason (?:is|for this)\s+([^.]{10,100})/i,
      /this is (?:due to|because)\s+([^.]{10,100})/i,
      /based on\s+([^.]{10,100})/i,
      /since\s+([^.]{10,100})/i,
    ];

    for (const pattern of reasoningPatterns) {
      const match = response.match(pattern);
      if (match) return match[1].trim();
    }

    return `Turn ${this.extractionContext.turnNumber}: processing user request`;
  }

  private extractResultSummary(turn: ConversationTurn, outcome: AgentStateOutcome): string {
    const response = turn.assistantResponse;

    if (outcome === 'failure') {
      // Try to extract the error description
      const errorMatch = response.match(
        /(?:error|failed|cannot|unable)[:\s]+([^.]{10,150})/i
      );
      if (errorMatch) return errorMatch[1].trim();
    }

    // First sentence of response as summary
    const firstSentence = response.match(/^[^.!?]{10,200}[.!?]/);
    if (firstSentence) return firstSentence[0].trim();

    return response.slice(0, 150).trim();
  }

  private extractLesson(turn: ConversationTurn): string | null {
    // Only extract lessons from failures or partial outcomes
    const outcome = this.extractOutcome(turn);
    if (outcome !== 'failure' && outcome !== 'partial') return null;

    const lessonPatterns = [
      /(?:lesson|takeaway|key insight)[:\s]+([^.]{10,150})/i,
      /(?:next time|in the future|going forward)[,:\s]+([^.]{10,150})/i,
      /(?:should|could) (?:have|instead)\s+([^.]{10,150})/i,
    ];

    for (const pattern of lessonPatterns) {
      const match = turn.assistantResponse.match(pattern);
      if (match) return match[1].trim();
    }

    // Generic lesson from failure
    if (outcome === 'failure') {
      return `Action failed at turn ${this.extractionContext.turnNumber}`;
    }

    return null;
  }

  private extractConstraint(turn: ConversationTurn): string | null {
    const constraintPatterns = [
      /(?:cannot|can't|unable to|not allowed to|restricted from)\s+([^.]{10,100})/i,
      /(?:limitation|constraint|restriction)[:\s]+([^.]{10,100})/i,
      /(?:not possible|not supported|not available)\s+([^.]{10,100})/i,
      /(?:requires?|must have|needs?)\s+([^.]{10,100})/i,
    ];

    for (const pattern of constraintPatterns) {
      const match = turn.assistantResponse.match(pattern);
      if (match) return match[1].trim();
    }

    return null;
  }

  private extractRecommendation(turn: ConversationTurn): string | null {
    const recommendationPatterns = [
      /(?:i recommend|i suggest|you should|consider)\s+([^.]{10,150})/i,
      /(?:the best approach|a better approach|instead, try)\s+([^.]{10,150})/i,
    ];

    for (const pattern of recommendationPatterns) {
      const match = turn.assistantResponse.match(pattern);
      if (match) return match[1].trim();
    }

    return null;
  }

  private findSupersededEntry(goal: string): AgentStateEntry | undefined {
    // Find an active entry with the same or very similar goal
    const goalWords = new Set(goal.toLowerCase().split(/\s+/).filter(w => w.length > 3));

    return this.stateEntries.find(entry => {
      if (!entry.active) return false;
      const entryGoalWords = new Set(
        entry.goal.toLowerCase().split(/\s+/).filter(w => w.length > 3)
      );
      const overlap = [...goalWords].filter(w => entryGoalWords.has(w));
      // Consider it the same goal if >60% word overlap
      return overlap.length / Math.max(goalWords.size, 1) > 0.6;
    });
  }

  private updateGoals(currentGoal: string, outcome: AgentStateOutcome): string[] {
    const goals = [...this.extractionContext.sessionGoals];

    if (outcome === 'success') {
      // Remove completed goal
      const idx = goals.findIndex(g => g === currentGoal);
      if (idx >= 0) goals.splice(idx, 1);
    } else if (!goals.includes(currentGoal)) {
      goals.push(currentGoal);
    }

    this.extractionContext.sessionGoals = goals;
    return goals;
  }

  // ==========================================================================
  // Existing Methods (preserved)
  // ==========================================================================

  /**
   * Process the save queue (async, non-blocking)
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.saveQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.saveQueue.length > 0) {
      const item = this.saveQueue.shift();
      if (!item) continue;

      try {
        await this.saveSync(item.turn);
        item.resolve(true);
      } catch (error) {
        this.config.logger.error('Queue processing error', { error });
        item.reject(
          error instanceof Error ? error : new Error('Unknown error')
        );
      }
    }

    this.isProcessing = false;
  }

  /**
   * Classify importance of a conversation turn
   */
  private async classifyImportance(
    turn: ConversationTurn
  ): Promise<number> {
    this.config.logger.debug('Classifying conversation importance');

    // For now, use a simple heuristic
    // In production, this would call the metacognition engine's classification API
    const importance = this.calculateHeuristicImportance(turn);

    this.config.logger.debug('Importance classified', { importance });

    return importance;
  }

  /**
   * Calculate importance using heuristics
   */
  private calculateHeuristicImportance(turn: ConversationTurn): number {
    let score = 0.5; // Base importance

    // Length of response (longer = potentially more important)
    const responseLength = turn.assistantResponse.length;
    if (responseLength > 1000) score += 0.2;
    else if (responseLength > 500) score += 0.1;

    // Question indicators (questions often signal important information gathering)
    const questionCount = (turn.userMessage.match(/\?/g) || []).length;
    score += Math.min(questionCount * 0.1, 0.2);

    // Exclamation points (excitement/importance)
    const exclamationCount = (turn.userMessage.match(/!/g) || []).length;
    score += Math.min(exclamationCount * 0.05, 0.1);

    // Code blocks (technical content is often important)
    const codeBlockCount = (turn.assistantResponse.match(/```/g) || []).length / 2;
    score += Math.min(codeBlockCount * 0.1, 0.2);

    // Keywords indicating importance
    const importantKeywords = [
      'important',
      'critical',
      'remember',
      'note',
      'warning',
      'error',
      'issue',
      'problem',
      'solution',
      'decision',
    ];

    const lowerMessage = turn.userMessage.toLowerCase();
    const keywordMatches = importantKeywords.filter((keyword) =>
      lowerMessage.includes(keyword)
    ).length;
    score += Math.min(keywordMatches * 0.1, 0.3);

    // Clamp between 0 and 1
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Wait for all queued saves to complete
   */
  async flush(): Promise<void> {
    this.config.logger.debug('Flushing save queue', {
      queueSize: this.saveQueue.length,
    });

    while (this.saveQueue.length > 0 || this.isProcessing) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.config.logger.info('Save queue flushed');
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.saveQueue.length;
  }

  /**
   * Handle API errors
   */
  private handleAPIError(error: unknown): APIError {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status || 500;
      const message =
        error.response?.data?.message ||
        error.message ||
        'Unknown API error';

      return new APIError(message, status, {
        url: error.config?.url,
        method: error.config?.method,
      });
    }

    if (error instanceof Error) {
      return new APIError(error.message, 500);
    }

    return new APIError('Unknown error occurred', 500, { error });
  }
}
