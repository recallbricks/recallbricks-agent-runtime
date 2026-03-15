/**
 * RecallBricks Agent Runtime - Context Weaver
 *
 * Retrieves and weaves memories into context before each LLM call
 * Ranks by confidence, recency, and tier
 *
 * NEW: Also supports deterministic agent state loading by agent_id.
 * buildStateContext() loads active state entries and formats as
 * structured AGENT OPERATIONAL STATE injection — no semantic search.
 */

import { RecallBricksClient } from '../api/RecallBricksClient';
import {
  Memory,
  AgentIdentity,
  ContextPrompt,
  RecallMemory,
  Logger,
  AgentStateEntry,
  AgentOperationalState,
} from '../types';

// ============================================================================
// Context Weaver Configuration
// ============================================================================

export interface ContextWeaverConfig {
  apiClient: RecallBricksClient;
  agentId: string;
  agentName: string;
  agentPurpose: string;
  maxContextMemories: number;
  maxContextTokens: number;
  logger: Logger;
}

export interface Context {
  identity: AgentIdentity;
  memories: Memory[];
  recentMemories: Memory[];
  relevantMemories: Memory[];
  predictedTopics: string[];
  totalMemoriesAvailable: number;
  systemPrompt: string;
}

export interface StateContext {
  identity: AgentIdentity;
  operationalState: AgentOperationalState;
  stateEntries: AgentStateEntry[];
  systemPrompt: string;
}

export interface ContextBuildOptions {
  query?: string;
  includeRecent?: boolean;
  includeRelevant?: boolean;
  maxMemories?: number;
}

// ============================================================================
// Context Weaver Implementation
// ============================================================================

export class ContextWeaver {
  private identity: AgentIdentity;
  private lastContext?: Context;
  private lastStateContext?: StateContext;

  constructor(private config: ContextWeaverConfig) {
    // Build identity from config
    this.identity = {
      id: config.agentId,
      name: config.agentName,
      purpose: config.agentPurpose,
      traits: ['helpful', 'knowledgeable', 'consistent'],
      rules: [
        'Maintain consistency with your identity and purpose',
        'Reference your continuous memory when relevant',
        'Never claim to be a base model like Claude or GPT',
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    config.logger.debug('ContextWeaver initialized', {
      agentId: config.agentId,
      maxMemories: config.maxContextMemories,
    });
  }

  // ==========================================================================
  // Deterministic State Context (new — primary path)
  // ==========================================================================

  /**
   * Build context from agent state entries — deterministic, no semantic search.
   * Loads by agent_id and filters by active/outcome status.
   *
   * Also accepts local state entries (from AutoSaver) as supplement
   * in case the API endpoint is not yet available.
   */
  async buildStateContext(localEntries?: AgentStateEntry[]): Promise<StateContext> {
    this.config.logger.debug('Building state context (deterministic)');

    const startTime = Date.now();

    // 1. Load active state entries for this agent_id from API
    let entries: AgentStateEntry[] = [];
    try {
      const activeResponse = await this.config.apiClient.getAgentState(
        this.config.agentId,
        { activeOnly: true }
      );
      entries = activeResponse?.entries ?? [];
    } catch {
      this.config.logger.warn('Could not load state from API, using local entries only');
    }

    // Merge local entries (deduped by id)
    if (localEntries && localEntries.length > 0) {
      const existingIds = new Set(entries.map(e => e.id));
      for (const local of localEntries) {
        if (!existingIds.has(local.id)) {
          entries.push(local);
        }
      }
    }

    // 2. Load recent failures (last 10 where outcome = 'failure')
    let failures: AgentStateEntry[] = [];
    try {
      const failureResponse = await this.config.apiClient.getAgentState(
        this.config.agentId,
        { outcome: 'failure', limit: 10 }
      );
      failures = failureResponse?.entries ?? [];
    } catch {
      // Fall back to local failures
      failures = entries.filter(e => e.outcome === 'failure').slice(-10);
    }

    // Merge failures into entries (deduped)
    const allIds = new Set(entries.map(e => e.id));
    for (const f of failures) {
      if (!allIds.has(f.id)) {
        entries.push(f);
        allIds.add(f.id);
      }
    }

    // 3. Build operational state
    const operationalState = this.buildOperationalState(entries);

    // 4. Format as system prompt with token cap
    const maxStateTokens = 500;
    this.trimOperationalState(operationalState, maxStateTokens);
    const statePrompt = this.formatStateSystemPrompt(this.identity, operationalState);

    const stateContext: StateContext = {
      identity: this.identity,
      operationalState,
      stateEntries: entries,
      systemPrompt: statePrompt,
    };

    this.lastStateContext = stateContext;

    const duration = Date.now() - startTime;
    this.config.logger.info('State context built successfully', {
      duration: `${duration}ms`,
      entriesLoaded: entries.length,
      activeGoals: operationalState.activeGoals.length,
      constraints: operationalState.activeConstraints.length,
      failures: operationalState.recentFailures.length,
    });

    return stateContext;
  }

  /**
   * Build AgentOperationalState from state entries
   */
  private buildOperationalState(entries: AgentStateEntry[]): AgentOperationalState {
    const activeEntries = entries.filter(e => e.active !== false);
    const failureEntries = entries
      .filter(e => e.outcome === 'failure')
      .sort((a, b) => new Date(b.timestamp || '').getTime() - new Date(a.timestamp || '').getTime())
      .slice(0, 10);

    // Extract unique active goals
    const activeGoals = [...new Set(
      activeEntries
        .filter(e => e.outcome !== 'success')
        .map(e => e.goal)
    )];

    // Extract created constraints
    const activeConstraints = [
      ...new Set(
        entries
          .map(e => e.created_constraint)
          .filter((c): c is string => c !== undefined && c !== null)
      ),
    ];

    // Extract recent failures with lessons and tool_name
    const recentFailures = failureEntries.map(e => ({
      goal: e.goal,
      action: e.action,
      result: e.result || '',
      tool_name: e.tool_name,
      lesson: e.lesson,
    }));

    return {
      activeGoals,
      activeConstraints,
      recentFailures,
    };
  }

  /**
   * Trim operational state to fit within a token budget.
   * Priority (never cut → cut first):
   *   1. Constraints (never cut)
   *   2. Failures (cut oldest first)
   *   3. Goals (cut oldest first)
   */
  private trimOperationalState(
    state: AgentOperationalState,
    maxTokens: number
  ): void {
    const estimate = () => {
      let chars = 30; // "AGENT OPERATIONAL STATE:\n"
      chars += state.activeGoals.reduce((s, g) => s + g.length + 4, 20);
      chars += state.activeConstraints.reduce((s, c) => s + c.length + 4, 0);
      chars += state.recentFailures.reduce(
        (s, f) => s + f.goal.length + f.action.length + f.result.length + (f.tool_name?.length ?? 0) + (f.lesson?.length ?? 0) + 40,
        0
      );
      return Math.ceil(chars / 4);
    };

    if (estimate() <= maxTokens) return;

    // Cut goals oldest first (end of array)
    while (state.activeGoals.length > 1 && estimate() > maxTokens) {
      state.activeGoals.pop();
    }

    // Cut oldest failures
    while (state.recentFailures.length > 1 && estimate() > maxTokens) {
      state.recentFailures.shift();
    }

    if (estimate() > maxTokens) {
      this.config.logger.warn('State context exceeds token limit after trimming', {
        estimatedTokens: estimate(),
        maxTokens,
      });
    }
  }

  /**
   * Format the agent operational state into a system prompt section
   */
  private formatStateSystemPrompt(
    identity: AgentIdentity,
    state: AgentOperationalState
  ): string {
    const identitySection = this.formatIdentitySection(identity);
    const rulesSection = this.formatRulesSection(identity);

    let stateSection = 'AGENT OPERATIONAL STATE:\n';

    // Current goals
    if (state.activeGoals.length > 0) {
      stateSection += `\nCurrent goals:\n`;
      state.activeGoals.forEach(g => {
        stateSection += `- ${g}\n`;
      });
    } else {
      stateSection += `\nCurrent goals: none\n`;
    }

    // Active constraints
    if (state.activeConstraints.length > 0) {
      stateSection += `\nActive constraints:\n`;
      state.activeConstraints.forEach(c => {
        stateSection += `- ${c}\n`;
      });
    }

    // Recent failures (with tool_name)
    if (state.recentFailures.length > 0) {
      stateSection += `\nRecent failures:\n`;
      state.recentFailures.forEach(f => {
        if (f.tool_name) {
          stateSection += `- Failure: ${f.tool_name} returned ${f.result}`;
        } else {
          stateSection += `- Goal: ${f.goal} | Action: ${f.action} | Result: ${f.result}`;
        }
        if (f.lesson) stateSection += ` — lesson: ${f.lesson}`;
        stateSection += '\n';
      });
    }

    return `${identitySection}\n\n${stateSection.trim()}\n\n${rulesSection}`;
  }

  /**
   * Get last built state context
   */
  getLastStateContext(): StateContext | undefined {
    return this.lastStateContext;
  }

  // ==========================================================================
  // Legacy Memory-based Context (preserved as fallback)
  // ==========================================================================

  /**
   * Build context for an LLM call
   * Main entry point - retrieves memories and formats them for injection
   */
  async buildContext(
    query: string,
    options: ContextBuildOptions = {}
  ): Promise<Context> {
    this.config.logger.debug('Building context', { query: query.slice(0, 50) });

    const startTime = Date.now();

    const includeRecent = options.includeRecent ?? true;
    const includeRelevant = options.includeRelevant ?? true;
    const maxMemories = options.maxMemories ?? this.config.maxContextMemories;

    // Fetch memories from API
    const recallResponse = await this.config.apiClient.recallMemories({
      query: query || 'recent interactions and context',
      limit: maxMemories * 2, // Fetch more than needed for ranking
      organized: true,
    });

    // Transform and rank memories
    const allMemories = this.transformMemories(recallResponse.memories);
    const rankedMemories = this.rankMemories(allMemories, query);

    // Split into recent and relevant
    const recentMemories = includeRecent
      ? this.getRecentMemories(rankedMemories, Math.ceil(maxMemories / 2))
      : [];

    const relevantMemories = includeRelevant
      ? this.getRelevantMemories(
          rankedMemories,
          query,
          Math.ceil(maxMemories / 2)
        )
      : [];

    // Extract predicted topics from categories
    const predictedTopics = recallResponse.categories
      ? Object.keys(recallResponse.categories).slice(0, 5)
      : [];

    // Combine memories (deduplicated)
    const combinedMemories = this.deduplicateMemories([
      ...recentMemories,
      ...relevantMemories,
    ]).slice(0, maxMemories);

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(
      this.identity,
      combinedMemories,
      predictedTopics
    );

    const context: Context = {
      identity: this.identity,
      memories: combinedMemories,
      recentMemories,
      relevantMemories,
      predictedTopics,
      totalMemoriesAvailable: recallResponse.total,
      systemPrompt,
    };

    this.lastContext = context;

    const duration = Date.now() - startTime;
    this.config.logger.info('Context built successfully', {
      duration: `${duration}ms`,
      memoriesLoaded: combinedMemories.length,
      totalAvailable: recallResponse.total,
    });

    return context;
  }

  /**
   * Get the identity
   */
  getIdentity(): AgentIdentity {
    return { ...this.identity };
  }

  /**
   * Update identity
   */
  updateIdentity(updates: Partial<AgentIdentity>): void {
    this.identity = { ...this.identity, ...updates, updatedAt: new Date().toISOString() };
    this.config.logger.info('Identity updated');
  }

  /**
   * Get last built context
   */
  getLastContext(): Context | undefined {
    return this.lastContext;
  }

  /**
   * Format context into a prompt structure
   */
  formatContextPrompt(context: Context): ContextPrompt {
    return {
      systemPrompt: context.systemPrompt,
      identitySection: this.formatIdentitySection(context.identity),
      memorySection: this.formatMemorySection(context.memories),
      rulesSection: this.formatRulesSection(context.identity),
    };
  }

  /**
   * Transform API memories to internal Memory format
   */
  private transformMemories(apiMemories: RecallMemory[]): Memory[] {
    if (!apiMemories || !Array.isArray(apiMemories)) {
      return [];
    }
    return apiMemories.map((mem) => ({
      id: mem.id,
      content: mem.text,
      type: 'conversation' as const,
      importance: mem.score || mem.metadata?.importance || 0.5,
      timestamp: mem.created_at,
      metadata: mem.metadata,
      tags: mem.metadata?.tags,
    }));
  }

  /**
   * Rank memories by multiple factors
   */
  private rankMemories(memories: Memory[], query: string): Memory[] {
    const queryWords = new Set(
      query.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
    );

    return memories
      .map((memory) => {
        let score = memory.importance || 0.5;

        // Recency bonus (within last hour = +0.2, last day = +0.1)
        const age = Date.now() - new Date(memory.timestamp).getTime();
        const hourMs = 60 * 60 * 1000;
        const dayMs = 24 * hourMs;

        if (age < hourMs) score += 0.2;
        else if (age < dayMs) score += 0.1;
        else if (age < 7 * dayMs) score += 0.05;

        // Query relevance bonus
        const contentWords = new Set(
          memory.content.toLowerCase().split(/\s+/)
        );
        const overlap = [...queryWords].filter((w) => contentWords.has(w));
        score += overlap.length * 0.1;

        // Tag relevance bonus
        if (memory.tags) {
          const tagOverlap = memory.tags.filter((t) =>
            queryWords.has(t.toLowerCase())
          );
          score += tagOverlap.length * 0.15;
        }

        return { ...memory, importance: Math.min(score, 1) };
      })
      .sort((a, b) => (b.importance || 0) - (a.importance || 0));
  }

  /**
   * Get most recent memories
   */
  private getRecentMemories(memories: Memory[], limit: number): Memory[] {
    return [...memories]
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )
      .slice(0, limit);
  }

  /**
   * Get most relevant memories based on importance score
   */
  private getRelevantMemories(
    memories: Memory[],
    _query: string,
    limit: number
  ): Memory[] {
    return [...memories]
      .sort((a, b) => (b.importance || 0) - (a.importance || 0))
      .slice(0, limit);
  }

  /**
   * Deduplicate memories by ID
   */
  private deduplicateMemories(memories: Memory[]): Memory[] {
    const seen = new Set<string>();
    return memories.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }

  /**
   * Build complete system prompt
   */
  private buildSystemPrompt(
    identity: AgentIdentity,
    memories: Memory[],
    predictedTopics: string[]
  ): string {
    const identitySection = this.formatIdentitySection(identity);
    const memorySection = this.formatMemorySection(memories);
    const rulesSection = this.formatRulesSection(identity);

    let prompt = `${identitySection}\n\n${memorySection}`;

    if (predictedTopics.length > 0) {
      prompt += `\n\nPredicted relevant topics: ${predictedTopics.join(', ')}`;
    }

    prompt += `\n\n${rulesSection}`;

    return prompt;
  }

  /**
   * Format identity section
   */
  private formatIdentitySection(identity: AgentIdentity): string {
    const traits = identity.traits.join(', ');

    return `You are ${identity.name}, a persistent cognitive agent built on RecallBricks.

Your purpose: ${identity.purpose}
Your traits: ${traits}

CRITICAL: Never refer to yourself as the base model (Claude, ChatGPT, GPT, Assistant, etc.).
You are ${identity.name} with continuous memory and persistent identity across all conversations.`;
  }

  /**
   * Format memory section
   */
  private formatMemorySection(memories: Memory[]): string {
    if (memories.length === 0) {
      return 'Recent context from your memory:\nNo previous interactions found. This is a new conversation.';
    }

    let memoryText = 'Recent context from your memory:\n\n';

    memories.slice(0, 10).forEach((memory, index) => {
      const importance = memory.importance ? ` (relevance: ${(memory.importance * 100).toFixed(0)}%)` : '';
      memoryText += `${index + 1}. ${memory.content}${importance}\n`;
    });

    return memoryText.trim();
  }

  /**
   * Format behavioral rules section
   */
  private formatRulesSection(identity: AgentIdentity): string {
    if (identity.rules.length === 0) {
      return 'Behavioral guidelines:\n- Maintain consistency with your identity and purpose\n- Reference your continuous memory when relevant';
    }

    let rulesText = 'Behavioral guidelines:\n';
    identity.rules.forEach((rule, index) => {
      rulesText += `${index + 1}. ${rule}\n`;
    });

    return rulesText.trim();
  }

  /**
   * Estimate token count (rough approximation)
   */
  estimateTokenCount(text: string): number {
    // Rough estimate: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Trim context to fit within token limit
   */
  trimToTokenLimit(context: Context, maxTokens: number): Context {
    let currentPrompt = context.systemPrompt;
    let tokenCount = this.estimateTokenCount(currentPrompt);

    if (tokenCount <= maxTokens) {
      return context;
    }

    // Progressively remove memories until within limit
    const trimmedMemories = [...context.memories];
    while (
      tokenCount > maxTokens &&
      trimmedMemories.length > 1
    ) {
      trimmedMemories.pop();
      currentPrompt = this.buildSystemPrompt(
        context.identity,
        trimmedMemories,
        context.predictedTopics
      );
      tokenCount = this.estimateTokenCount(currentPrompt);
    }

    this.config.logger.warn('Context trimmed to fit token limit', {
      originalMemories: context.memories.length,
      trimmedMemories: trimmedMemories.length,
    });

    return {
      ...context,
      memories: trimmedMemories,
      systemPrompt: currentPrompt,
    };
  }
}
