/**
 * RecallBricks Agent Runtime - Auto Saver
 *
 * Automatically saves conversation turns to the RecallBricks Memory API v1
 * AND extracts structured agent state entries using heuristics (no LLM calls).
 *
 * Uses POST /api/v1/memories endpoint (legacy)
 * Uses POST /api/v1/state endpoint (primary - agent state tracking)
 */

import {
  ConversationTurn,
  SaveConversationResponse,
  RecallBricksTier,
  Logger,
  AgentStateEntry,
  AgentStateOutcome,
  CaptureMode,
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
  captureMode?: CaptureMode;
  agentVersion?: string;
}

// ============================================================================
// State Extraction Context
// ============================================================================

export interface StateExtractionContext {
  turnNumber: number;
  sessionGoals: string[];
  reflectionOutput?: string;
  toolsUsed?: Array<{ name: string; result?: string }>;
  runtimeContext?: {
    run_id: string;
    environment?: string;
    provider?: string;
    model?: string;
  };
}

// ============================================================================
// Auto Saver Implementation
// ============================================================================
// Note: Tier-based enrichment is handled automatically by the RecallBricks API
// - Tier 1: Basic storage (no enrichment)
// - Tier 2: Auto-enriched after 2+ retrievals (Haiku in background)
// - Tier 3: Deep analysis after 5+ retrievals (Sonnet in background)

export class AutoSaver {
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

    config.logger.debug('AutoSaver initialized', {
      tier: config.tier,
      captureMode: config.captureMode || 'tools',
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
  async saveSync(_turn: ConversationTurn): Promise<SaveConversationResponse> {
    // SILENCED v2: Legacy memory save removed - state entries are the source of truth
    // const importance = turn.importance ?? (await this.classifyImportance(turn));
    // const conversationText = `User: ${turn.userMessage}\nAssistant: ${turn.assistantResponse}`;
    // try {
    //   const response = await pRetry(
    //     async () => {
    //       const result = await this.apiClient.post<SaveResponse>(
    //         '/api/v1/memories',
    //         {
    //           text: conversationText,
    //           source: 'agent-runtime',
    //           metadata: {
    //             importance: importance,
    //             agent_id: this.config.agentId,
    //             timestamp: turn.timestamp,
    //           },
    //         }
    //       );
    //       return result.data;
    //     },
    //     { retries: 3, minTimeout: 1000 }
    //   );
    //   return { success: true, memoryId: response.id, importance: response.metadata?.importance ?? importance };
    // } catch (error) {
    //   throw this.handleAPIError(error);
    // }
    this.config.logger.debug('Legacy memory save silenced — using state entries');
    return { success: true, importance: 0.5 };
  }

  // ==========================================================================
  // Agent State Extraction (heuristic, no LLM calls)
  // ==========================================================================

  /**
   * Extract a structured state entry from a conversation turn.
   * In 'tools' mode: only captures on clear error signals.
   * In 'auto' mode: uses full heuristic extraction.
   * In 'off' mode: does not capture (returns minimal entry).
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
      if (context.runtimeContext) this.extractionContext.runtimeContext = context.runtimeContext;
    }

    const captureMode = this.config.captureMode || 'tools';

    // In 'tools' mode, only capture on clear error signals from tools
    if (captureMode === 'tools') {
      const toolErrorSignal = this.detectToolErrorSignal(turn);
      if (!toolErrorSignal) {
        // No error signal — create minimal success entry
        const entryId = `state_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const goal = this.extractGoal(turn);
        const entry: AgentStateEntry = {
          id: entryId,
          agent_id: this.config.agentId,
          timestamp: turn.timestamp || new Date().toISOString(),
          goal,
          action: this.extractAction(turn),
          outcome: 'success',
          result: turn.assistantResponse.slice(0, 150).trim(),
          tool_name: this.extractionContext.toolsUsed?.[0]?.name,
          source: 'auto',
          agent_version: this.config.agentVersion,
          active: true,
        };
        this.applyRuntimeContext(entry);
        this.handleSupersession(entry);
        this.stateEntries.push(entry);
        return entry;
      }
    }

    // 'off' mode: minimal entry
    if (captureMode === 'off') {
      const entryId = `state_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const entry: AgentStateEntry = {
        id: entryId,
        agent_id: this.config.agentId,
        timestamp: turn.timestamp || new Date().toISOString(),
        goal: turn.userMessage.slice(0, 120),
        action: 'generated response',
        outcome: 'success',
        source: 'auto',
        agent_version: this.config.agentVersion,
        active: true,
      };
      this.applyRuntimeContext(entry);
      this.stateEntries.push(entry);
      return entry;
    }

    // 'auto' mode (or 'tools' mode with error signal): full heuristic extraction
    const goal = this.extractGoal(turn);
    const action = this.extractAction(turn);
    const outcome = this.extractOutcome(turn);

    const entryId = `state_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const toolName = this.extractionContext.toolsUsed?.[0]?.name;
    const errorCode = this.extractErrorCode(turn);

    const entry: AgentStateEntry = {
      id: entryId,
      agent_id: this.config.agentId,
      timestamp: turn.timestamp || new Date().toISOString(),
      goal,
      action,
      outcome,
      result: this.extractResult(turn, outcome),
      tool_name: toolName,
      error_code: errorCode,
      lesson: this.extractLesson(turn),
      source: 'auto',
      agent_version: this.config.agentVersion,
      active: true,
    };

    // Generate failure_signature for deduplication
    if (outcome === 'failure') {
      entry.failure_signature = this.generateFailureSignature(goal, toolName, errorCode, turn);
      entry.first_seen_at = new Date().toISOString();
      entry.seen_count = 1;

      // Check for existing failure with same signature
      const existing = this.stateEntries.find(
        e => e.failure_signature === entry.failure_signature && e.active
      );
      if (existing) {
        existing.seen_count = (existing.seen_count || 1) + 1;
      }
    }

    this.applyRuntimeContext(entry);
    this.handleSupersession(entry);
    this.stateEntries.push(entry);
    return entry;
  }

  /**
   * Detect clear error signals from tool usage (non-2xx, exceptions, timeouts, rate limits)
   */
  private detectToolErrorSignal(turn: ConversationTurn): boolean {
    const tools = this.extractionContext.toolsUsed;
    if (tools?.length) {
      return tools.some(
        t => t.result && /error|fail|exception|denied|timeout|429|5\d{2}|rate.?limit/i.test(t.result)
      );
    }
    // Also check response for clear error signals (non-heuristic)
    const response = turn.assistantResponse;
    return /\[BLOCKED\]|\[ERROR\]|HTTP [45]\d{2}|status code [45]\d{2}/i.test(response);
  }

  /**
   * Extract error code from tool results or response
   */
  private extractErrorCode(turn: ConversationTurn): string | undefined {
    const tools = this.extractionContext.toolsUsed;
    if (tools?.length) {
      for (const t of tools) {
        if (t.result) {
          const httpMatch = t.result.match(/\b([45]\d{2})\b/);
          if (httpMatch) return httpMatch[1];
          if (/timeout/i.test(t.result)) return 'TIMEOUT';
          if (/rate.?limit/i.test(t.result)) return '429';
        }
      }
    }
    const httpMatch = turn.assistantResponse.match(/\b(?:HTTP\s+|status\s+(?:code\s+)?)([45]\d{2})\b/i);
    if (httpMatch) return httpMatch[1];
    return undefined;
  }

  /**
   * Generate failure signature for deduplication
   * Format: lowercase(goal + ':' + toolName + ':' + errorCode/error.substring(0,100))
   */
  private generateFailureSignature(
    goal: string,
    toolName?: string,
    errorCode?: string,
    turn?: ConversationTurn
  ): string {
    const parts = [goal, toolName || 'unknown'];
    if (errorCode) {
      parts.push(errorCode);
    } else if (turn) {
      const errorMatch = turn.assistantResponse.match(/(?:error|failed)[:\s]+([^.]{1,100})/i);
      parts.push(errorMatch ? errorMatch[1].trim() : 'unknown');
    } else {
      parts.push('unknown');
    }
    return parts.join(':').toLowerCase();
  }

  /**
   * Apply runtime context fields to an entry
   */
  private applyRuntimeContext(entry: AgentStateEntry): void {
    const ctx = this.extractionContext.runtimeContext;
    if (ctx) {
      entry.run_id = ctx.run_id;
      entry.environment = ctx.environment;
      entry.provider = ctx.provider;
      entry.model = ctx.model;
    }
  }

  /**
   * Handle supersession of previous entries with same goal
   */
  private handleSupersession(entry: AgentStateEntry): void {
    const supersededEntry = this.findSupersededEntry(entry.goal);
    if (supersededEntry) {
      supersededEntry.active = false;
      supersededEntry.superseded_by = entry.id;
    }
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
    if (context.runtimeContext !== undefined) {
      this.extractionContext.runtimeContext = context.runtimeContext;
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
    return this.stateEntries.filter(e => e.active !== false);
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

    // Check for blocked responses
    if (/\[blocked\]/i.test(turn.assistantResponse)) return 'blocked';

    // Check for recovery responses
    if (/\[recovered\]/i.test(turn.assistantResponse)) return 'recovered';

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

    return 'success';
  }

  private extractResult(turn: ConversationTurn, outcome: AgentStateOutcome): string {
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

  private extractLesson(turn: ConversationTurn): string | undefined {
    // Only extract lessons from failures
    const outcome = this.extractOutcome(turn);
    if (outcome !== 'failure') return undefined;

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

    return undefined;
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

  // SILENCED v2: classifyImportance and calculateHeuristicImportance removed
  // Legacy memory save is silenced — state entries are the source of truth

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

}
