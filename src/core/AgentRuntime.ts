/**
 * RecallBricks Agent Runtime - Main Orchestrator
 *
 * The universal cognitive runtime that coordinates all components
 * Provides automatic memory, reflection, and identity for any LLM
 */

import {
  RuntimeConfig,
  RuntimeOptions,
  LLMMessage,
  ChatResponse,
  ConversationTurn,
  AgentIdentity,
  MemoryContext,
  Logger,
  LLMProvider,
  WorkingMemoryClient,
  GoalsClient,
  MetacognitionClient,
  WorkingMemorySession,
  GoalTrackingResult,
  MetacognitionAssessment,
  AgentStateEntry,
} from '../types';
import { buildConfigFromOptions, createLogger } from '../config';
import { LLMAdapter } from './LLMAdapter';
import { ContextLoader } from './ContextLoader';
import { ContextWeaver, Context, StateContext } from './ContextWeaver';
import { AutoSaver } from './AutoSaver';
import { IdentityValidator } from './IdentityValidator';
import { ReflectionEngine, Reflection, ReasoningTrace } from './ReflectionEngine';
import { RecallBricksClient } from '../api/RecallBricksClient';

// ============================================================================
// Runtime Version
// ============================================================================

const RUNTIME_VERSION = '2.0.0';

// ============================================================================
// Agent Runtime Implementation
// ============================================================================

export class AgentRuntime {
  private config: RuntimeConfig;
  private logger: Logger;
  private llmAdapter?: LLMAdapter;
  private contextLoader: ContextLoader;
  private contextWeaver?: ContextWeaver;
  private autoSaver: AutoSaver;
  private identityValidator?: IdentityValidator;
  private reflectionEngine?: ReflectionEngine;
  private apiClient: RecallBricksClient;

  private currentIdentity?: AgentIdentity;
  private currentContext?: MemoryContext;
  private weavedContext?: Context;
  private stateContext?: StateContext;
  private previousTurn?: ConversationTurn;
  private conversationHistory: LLMMessage[] = [];
  private interactionCount = 0;

  // Autonomous agent clients
  public readonly workingMemory: WorkingMemoryClient;
  public readonly goals: GoalsClient;
  public readonly metacognition: MetacognitionClient;

  constructor(options: RuntimeOptions) {
    // Build configuration
    this.config = buildConfigFromOptions(options);
    this.logger = createLogger(this.config.debug);

    this.logger.info('Initializing RecallBricks Agent Runtime', {
      version: RUNTIME_VERSION,
      agentId: this.config.agentId,
      userId: this.config.userId,
      provider: this.config.llmConfig?.provider,
      tier: this.config.tier,
      mcpMode: this.config.mcpMode,
    });

    // Initialize API client
    this.apiClient = new RecallBricksClient({
      apiUrl: this.config.apiUrl!,
      apiKey: this.config.apiKey || '',
      userId: this.config.userId,
      logger: this.logger,
    });

    // Initialize LLM adapter only if not in MCP mode
    if (!this.config.mcpMode && this.config.llmConfig) {
      this.llmAdapter = new LLMAdapter(this.config.llmConfig, this.logger);
    }

    // Initialize ContextLoader (legacy)
    this.contextLoader = new ContextLoader({
      apiUrl: this.config.apiUrl!,
      apiKey: this.config.apiKey || '',
      agentId: this.config.agentId,
      userId: this.config.userId,
      agentName: this.config.agentName,
      agentPurpose: this.config.agentPurpose,
      cacheEnabled: this.config.cacheEnabled!,
      cacheTTL: this.config.cacheTTL!,
      maxContextTokens: this.config.maxContextTokens!,
      logger: this.logger,
    });

    // Initialize ContextWeaver (new)
    this.contextWeaver = new ContextWeaver({
      apiClient: this.apiClient,
      agentId: this.config.agentId,
      agentName: this.config.agentName || 'RecallBricks Agent',
      agentPurpose: this.config.agentPurpose || 'A persistent cognitive agent',
      maxContextMemories: 10,
      maxContextTokens: this.config.maxContextTokens!,
      logger: this.logger,
    });

    // Initialize AutoSaver (with API client for state tracking)
    this.autoSaver = new AutoSaver({
      apiUrl: this.config.apiUrl!,
      apiKey: this.config.apiKey || '',
      agentId: this.config.agentId,
      userId: this.config.userId,
      tier: this.config.tier!,
      logger: this.logger,
      apiClient: this.apiClient,
    });

    // Initialize ReflectionEngine if LLM is available
    if (this.llmAdapter) {
      this.reflectionEngine = new ReflectionEngine({
        llmAdapter: this.llmAdapter,
        apiClient: this.apiClient,
        agentId: this.config.agentId,
        agentName: this.config.agentName || 'RecallBricks Agent',
        reflectionInterval: 5, // Reflect after every 5 interactions
        confidenceThreshold: 0.6,
        logger: this.logger,
      });
    }

    // Register agent with RecallBricks (opt-in only)
    if (this.config.registerAgent === true) {
      this.registerAgent().catch((err) => {
        this.logger.debug('Agent registration skipped', { error: err.message });
      });
    }

    // Initialize autonomous agent clients
    this.workingMemory = this.createWorkingMemoryClient();
    this.goals = this.createGoalsClient();
    this.metacognition = this.createMetacognitionClient();

    this.logger.info('AgentRuntime initialized successfully');
  }

  /**
   * Create working memory client for autonomous agents
   */
  private createWorkingMemoryClient(): WorkingMemoryClient {
    const sessions = new Map<string, WorkingMemorySession>();
    const apiClient = this.apiClient;
    const logger = this.logger;
    const agentId = this.config.agentId;

    return {
      createSession: async (sessionId: string): Promise<WorkingMemorySession> => {
        logger.debug('Creating working memory session', { sessionId });

        const session: WorkingMemorySession = {
          sessionId,
          agentId,
          createdAt: new Date().toISOString(),
          entries: [],
          async addEntry(key: string, value: unknown, ttl?: number) {
            const entry = {
              key,
              value,
              timestamp: new Date().toISOString(),
              expiresAt: ttl ? new Date(Date.now() + ttl).toISOString() : undefined,
            };
            this.entries.push(entry);
            logger.debug('Working memory entry added', { sessionId, key });
            return entry;
          },
          async getEntry(key: string) {
            const entry = this.entries.find(e => e.key === key);
            if (entry?.expiresAt && new Date(entry.expiresAt) < new Date()) {
              return undefined;
            }
            return entry;
          },
          async removeEntry(key: string) {
            const index = this.entries.findIndex(e => e.key === key);
            if (index >= 0) {
              this.entries.splice(index, 1);
              return true;
            }
            return false;
          },
          async clear() {
            this.entries = [];
            logger.debug('Working memory session cleared', { sessionId });
          },
          async persist() {
            try {
              await apiClient.saveMemory({
                text: JSON.stringify({
                  type: 'working_memory_session',
                  sessionId,
                  entries: this.entries,
                }),
                tags: ['working_memory', sessionId],
                source: 'agent-runtime-autonomous',
              });
              logger.debug('Working memory session persisted', { sessionId });
            } catch (error) {
              logger.warn('Failed to persist working memory session', { sessionId, error });
            }
          },
        };

        sessions.set(sessionId, session);
        return session;
      },
      getSession: async (sessionId: string): Promise<WorkingMemorySession | undefined> => {
        return sessions.get(sessionId);
      },
      listSessions: async (): Promise<string[]> => {
        return Array.from(sessions.keys());
      },
    };
  }

  /**
   * Create goals client for autonomous agents
   */
  private createGoalsClient(): GoalsClient {
    const activeGoals = new Map<string, GoalTrackingResult>();
    const apiClient = this.apiClient;
    const logger = this.logger;

    return {
      trackGoal: async (goalId: string, steps: string[]): Promise<GoalTrackingResult> => {
        logger.info('Tracking goal', { goalId, stepCount: steps.length });

        const result: GoalTrackingResult = {
          goalId,
          steps: steps.map((description, index) => ({
            stepNumber: index + 1,
            description,
            status: 'pending',
          })),
          status: 'in_progress',
          startedAt: new Date().toISOString(),
          progress: 0,
          async completeStep(stepNumber: number) {
            const step = this.steps.find(s => s.stepNumber === stepNumber);
            if (step) {
              step.status = 'completed';
              step.completedAt = new Date().toISOString();
              this.progress = this.steps.filter(s => s.status === 'completed').length / this.steps.length;
              logger.debug('Goal step completed', { goalId, stepNumber, progress: this.progress });

              if (this.progress === 1) {
                this.status = 'completed';
                this.completedAt = new Date().toISOString();
              }
            }
          },
          async failStep(stepNumber: number, reason: string) {
            const step = this.steps.find(s => s.stepNumber === stepNumber);
            if (step) {
              step.status = 'failed';
              step.failureReason = reason;
              this.status = 'failed';
              logger.warn('Goal step failed', { goalId, stepNumber, reason });
            }
          },
        };

        activeGoals.set(goalId, result);

        // Persist goal to memory
        try {
          await apiClient.saveMemory({
            text: `Goal started: ${goalId} with ${steps.length} steps: ${steps.join(', ')}`,
            tags: ['goal', goalId, 'autonomous'],
            source: 'agent-runtime-autonomous',
          });
        } catch (error) {
          logger.warn('Failed to persist goal', { goalId, error });
        }

        return result;
      },
      getGoal: async (goalId: string): Promise<GoalTrackingResult | undefined> => {
        return activeGoals.get(goalId);
      },
      listGoals: async (): Promise<GoalTrackingResult[]> => {
        return Array.from(activeGoals.values());
      },
      cancelGoal: async (goalId: string): Promise<boolean> => {
        const goal = activeGoals.get(goalId);
        if (goal) {
          goal.status = 'cancelled';
          logger.info('Goal cancelled', { goalId });
          return true;
        }
        return false;
      },
    };
  }

  /**
   * Create metacognition client for autonomous agents
   */
  private createMetacognitionClient(): MetacognitionClient {
    const assessments: MetacognitionAssessment[] = [];
    const logger = this.logger;
    const reflectionEngine = () => this.reflectionEngine;

    return {
      assessResponse: async (response: string, confidence: number): Promise<MetacognitionAssessment> => {
        logger.debug('Assessing response', { responseLength: response.length, confidence });

        const assessment: MetacognitionAssessment = {
          timestamp: new Date().toISOString(),
          response: response.substring(0, 500), // Store truncated for memory
          confidence,
          needsReflection: confidence < 0.7,
          suggestions: [],
        };

        // Add suggestions based on confidence
        if (confidence < 0.5) {
          assessment.suggestions.push('Consider gathering more context before responding');
          assessment.suggestions.push('The response may need verification');
        } else if (confidence < 0.7) {
          assessment.suggestions.push('Response confidence is moderate - consider follow-up clarification');
        }

        // Check if reflection is recommended
        if (assessment.needsReflection && reflectionEngine()) {
          assessment.suggestions.push('Triggering background reflection for self-improvement');
        }

        assessments.push(assessment);
        return assessment;
      },
      getAssessmentHistory: async (): Promise<MetacognitionAssessment[]> => {
        return [...assessments];
      },
      getAverageConfidence: async (): Promise<number> => {
        if (assessments.length === 0) return 0;
        return assessments.reduce((sum, a) => sum + a.confidence, 0) / assessments.length;
      },
      triggerReflection: async (): Promise<void> => {
        const engine = reflectionEngine();
        if (engine) {
          logger.info('Metacognition triggering reflection');
          await engine.reflect('manual');
        } else {
          logger.warn('Reflection engine not available');
        }
      },
    };
  }

  /**
   * Send a chat message and get a contextual response
   *
   * This is the main entry point for the runtime
   */
  async chat(
    message: string,
    conversationHistory?: LLMMessage[]
  ): Promise<ChatResponse> {
    this.logger.info('Processing chat message', {
      messageLength: message.length,
      mcpMode: this.config.mcpMode,
    });

    const startTime = Date.now();
    this.interactionCount++;

    try {
      // Step 1: Save previous turn (if exists) — both legacy memory and state entry
      if (this.previousTurn && this.config.autoSave) {
        this.logger.debug('Saving previous conversation turn');
        // Legacy memory save (non-blocking)
        this.autoSaver.save(this.previousTurn).catch((err) => {
          this.logger.warn('Legacy memory save failed', { error: (err as Error).message });
        });
        // State entry extraction and save (non-blocking)
        this.autoSaver.saveStateEntry(this.previousTurn).catch((err) => {
          this.logger.warn('State entry save failed', { error: (err as Error).message });
        });
      }

      // Step 2a: Build deterministic state context
      this.logger.debug('Building agent state context (deterministic)');
      const localEntries = this.autoSaver.getActiveStateEntries();
      this.stateContext = await this.contextWeaver!.buildStateContext(localEntries);
      this.currentIdentity = this.stateContext.identity;

      // Step 2b: Also build legacy memory context (fallback / compatibility)
      this.logger.debug('Building context from Memory Graph');
      this.weavedContext = await this.contextWeaver!.buildContext(message);

      // Convert to legacy MemoryContext format for compatibility
      this.currentContext = {
        recentMemories: this.weavedContext.recentMemories,
        relevantMemories: this.weavedContext.relevantMemories,
        predictedContext: this.weavedContext.predictedTopics,
        totalMemories: this.weavedContext.totalMemoriesAvailable,
        lastUpdated: new Date().toISOString(),
      };

      // Step 3: Initialize identity validator
      if (this.config.validateIdentity && this.currentIdentity) {
        this.identityValidator = new IdentityValidator({
          agentIdentity: this.currentIdentity,
          autoCorrect: true,
          logger: this.logger,
        });
      }

      // In MCP mode, return context without calling LLM
      if (this.config.mcpMode) {
        this.logger.debug('MCP mode: returning context without LLM call');

        const duration = Date.now() - startTime;
        this.logger.info('Context loaded successfully in MCP mode', {
          duration: `${duration}ms`,
        });

        return {
          response: this.weavedContext.systemPrompt,
          metadata: {
            provider: 'none' as LLMProvider,
            model: 'mcp-mode',
            contextLoaded: true,
            identityValidated: false,
            autoSaved: false,
            tokensUsed: 0,
          },
        };
      }

      // Step 4: Build enriched message with context
      const enrichedMessages = this.buildEnrichedMessages(
        message,
        conversationHistory
      );

      // Step 5: Call LLM with enriched context
      if (!this.llmAdapter) {
        throw new Error('LLM adapter not initialized. This should not happen in non-MCP mode.');
      }

      this.logger.debug('Calling LLM with enriched context');
      const llmResponse = await this.llmAdapter.chat(enrichedMessages);

      // Step 6: Validate response for identity leakage
      let finalResponse = llmResponse.content;
      let identityValidated = false;

      if (this.identityValidator) {
        this.logger.debug('Validating response for identity violations');
        const validation = this.identityValidator.validate(llmResponse.content);

        if (!validation.isValid) {
          this.logger.warn('Identity violations detected', {
            count: validation.violations.length,
          });

          if (validation.correctedResponse) {
            finalResponse = validation.correctedResponse;
            identityValidated = true;
          }
        } else {
          identityValidated = true;
        }
      }

      // Step 7: Store current turn for next save
      this.previousTurn = {
        userMessage: message,
        assistantResponse: finalResponse,
        timestamp: new Date().toISOString(),
      };

      // Record interaction for reflection engine
      if (this.reflectionEngine) {
        this.reflectionEngine.recordInteraction(this.previousTurn);
      }

      // Step 8: Update conversation history
      this.conversationHistory.push(
        { role: 'user', content: message },
        { role: 'assistant', content: finalResponse }
      );

      const duration = Date.now() - startTime;

      this.logger.info('Chat message processed successfully', {
        duration: `${duration}ms`,
        tokensUsed: llmResponse.usage?.totalTokens,
      });

      // Check if we should trigger a reflection
      if (this.reflectionEngine) {
        const { shouldReflect, trigger } = this.reflectionEngine.shouldReflect();
        if (shouldReflect && trigger) {
          // Run reflection in background (don't block response)
          this.reflectionEngine.reflect(trigger).then((reflection) => {
            this.logger.info('Background reflection completed', {
              insights: reflection.insights.length,
            });
          }).catch((err) => {
            this.logger.warn('Background reflection failed', { error: err.message });
          });
        }
      }

      return {
        response: finalResponse,
        metadata: {
          provider: llmResponse.provider,
          model: llmResponse.model,
          contextLoaded: true,
          identityValidated,
          autoSaved: this.config.autoSave!,
          tokensUsed: llmResponse.usage?.totalTokens,
        },
      };
    } catch (error) {
      this.logger.error('Chat processing failed', { error });
      throw error;
    }
  }

  /**
   * Trigger a reflection analysis
   */
  async reflect(): Promise<Reflection> {
    if (!this.reflectionEngine) {
      throw new Error('Reflection engine not initialized (requires LLM adapter)');
    }

    this.logger.info('Triggering manual reflection');
    return this.reflectionEngine.reflect('manual');
  }

  /**
   * Explain reasoning for a query (Chain of Thought)
   *
   * Primary path: builds trace from state entries (no LLM call).
   * Fallback: uses LLM-based explain if no state entries exist.
   */
  async explain(query: string): Promise<ReasoningTrace> {
    if (!this.reflectionEngine) {
      throw new Error('Reflection engine not initialized (requires LLM adapter)');
    }

    // Primary: explain from agent state entries (no LLM call)
    const localEntries = this.autoSaver.getStateEntries();
    let apiEntries: AgentStateEntry[] = [];
    try {
      const response = await this.apiClient.getAgentState(this.config.agentId);
      apiEntries = response.entries;
    } catch {
      this.logger.debug('Could not fetch API state entries for explain');
    }

    // Merge and dedupe
    const allEntries = [...localEntries];
    const localIds = new Set(localEntries.map(e => e.id));
    for (const e of apiEntries) {
      if (!localIds.has(e.id)) allEntries.push(e);
    }

    if (allEntries.length > 0) {
      return this.reflectionEngine.explainFromState(query, allEntries);
    }

    // Fallback: LLM-based explain using memories
    const context = await this.contextWeaver!.buildContext(query);
    return this.reflectionEngine.explain(query, context.memories);
  }

  /**
   * Get all agent state entries (local + API)
   */
  getStateEntries(): AgentStateEntry[] {
    return this.autoSaver.getStateEntries();
  }

  /**
   * Get active agent state entries
   */
  getActiveStateEntries(): AgentStateEntry[] {
    return this.autoSaver.getActiveStateEntries();
  }

  /**
   * Build enriched messages with identity and context
   */
  private buildEnrichedMessages(
    userMessage: string,
    conversationHistory?: LLMMessage[]
  ): LLMMessage[] {
    const messages: LLMMessage[] = [];

    // Add system prompt — prefer state context (deterministic), fallback to memory context
    if (this.stateContext && this.stateContext.stateEntries.length > 0) {
      // Primary: deterministic agent state context
      messages.push({
        role: 'system',
        content: this.stateContext.systemPrompt,
      });
    } else if (this.weavedContext) {
      // Fallback: semantic memory context
      messages.push({
        role: 'system',
        content: this.weavedContext.systemPrompt,
      });
    } else if (this.currentIdentity && this.currentContext) {
      // Legacy fallback: ContextLoader
      const contextPrompt = this.contextLoader.formatContextPrompt(
        this.currentIdentity,
        this.currentContext
      );
      messages.push({
        role: 'system',
        content: contextPrompt.systemPrompt,
      });
    }

    // Add conversation history if provided
    if (conversationHistory && conversationHistory.length > 0) {
      messages.push(...conversationHistory);
    } else if (this.conversationHistory.length > 0) {
      // Use internal history (limit to last 10 messages)
      messages.push(...this.conversationHistory.slice(-10));
    }

    // Add current user message
    messages.push({
      role: 'user',
      content: userMessage,
    });

    return messages;
  }

  /**
   * Register agent with RecallBricks
   */
  private async registerAgent(): Promise<void> {
    try {
      await this.apiClient.registerAgent({
        agentId: this.config.agentId,
        runtimeVersion: RUNTIME_VERSION,
        metadata: {
          provider: this.config.llmConfig?.provider,
          tier: this.config.tier,
        },
      });
      this.logger.debug('Agent registered with RecallBricks');
    } catch {
      // Non-critical - endpoint might not exist yet
    }
  }

  /**
   * Get current agent identity
   */
  getIdentity(): AgentIdentity {
    return this.contextWeaver?.getIdentity() || this.currentIdentity!;
  }

  /**
   * Get current memory context
   */
  async getContext(): Promise<MemoryContext | undefined> {
    if (!this.currentContext) {
      const contextResponse = await this.contextLoader.loadContext();
      this.currentContext = contextResponse.context;
    }
    return this.currentContext;
  }

  /**
   * Refresh context from API (bypasses cache)
   */
  async refreshContext(): Promise<void> {
    this.logger.info('Refreshing context');
    this.contextLoader.clearCache();
    const contextResponse = await this.contextLoader.loadContext();
    this.currentIdentity = contextResponse.identity;
    this.currentContext = contextResponse.context;
    this.logger.info('Context refreshed successfully');
  }

  /**
   * Save current conversation turn immediately
   */
  async saveNow(): Promise<void> {
    if (this.previousTurn) {
      this.logger.info('Saving current conversation turn');
      await this.autoSaver.saveSync(this.previousTurn);
      this.previousTurn = undefined;
    } else {
      this.logger.warn('No conversation turn to save');
    }
  }

  /**
   * Wait for all pending saves to complete
   */
  async flush(): Promise<void> {
    this.logger.info('Flushing pending saves');
    await this.autoSaver.flush();
    this.logger.info('All saves completed');
  }

  /**
   * Shutdown the runtime gracefully
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down AgentRuntime');
    await this.flush();
    this.logger.info('AgentRuntime shutdown complete');
  }

  /**
   * Get conversation history
   */
  getConversationHistory(): LLMMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Clear conversation history
   */
  clearConversationHistory(): void {
    this.conversationHistory = [];
    this.logger.debug('Conversation history cleared');
  }

  /**
   * Get identity validation statistics
   */
  getValidationStats():
    | {
        total: number;
        byType: Record<string, number>;
        bySeverity: Record<string, number>;
      }
    | undefined {
    return this.identityValidator?.getViolationStats();
  }

  /**
   * Get reflection history
   */
  getReflectionHistory(): Reflection[] {
    return this.reflectionEngine?.getReflectionHistory() || [];
  }

  /**
   * Get configuration
   */
  getConfig(): RuntimeConfig {
    return { ...this.config };
  }

  /**
   * Get runtime version
   */
  getVersion(): string {
    return RUNTIME_VERSION;
  }

  /**
   * Update LLM configuration
   */
  updateLLMConfig(newConfig: Partial<RuntimeConfig['llmConfig']>): void {
    if (this.config.mcpMode) {
      this.logger.warn('Cannot update LLM config in MCP mode');
      return;
    }

    if (!this.config.llmConfig) {
      this.logger.warn('LLM config not initialized');
      return;
    }

    this.config.llmConfig = { ...this.config.llmConfig, ...newConfig };
    this.llmAdapter?.updateConfig(this.config.llmConfig);
    this.logger.info('LLM configuration updated');
  }

  /**
   * Get the API client for direct access
   */
  getApiClient(): RecallBricksClient {
    return this.apiClient;
  }

  // ============================================================================
  // Autonomous Agent Convenience Methods
  // ============================================================================

  /**
   * Create a working memory session for autonomous task execution
   * Convenience method that wraps workingMemory.createSession
   *
   * @param sessionId - Unique identifier for the session
   * @returns WorkingMemorySession for storing temporary task state
   */
  async createSession(sessionId: string): Promise<WorkingMemorySession> {
    this.logger.info('Creating autonomous session', { sessionId });
    return this.workingMemory.createSession(sessionId);
  }

  /**
   * Track a goal with defined steps for autonomous execution
   * Convenience method that wraps goals.trackGoal
   *
   * @param goalId - Unique identifier for the goal
   * @param steps - Array of step descriptions
   * @returns GoalTrackingResult for monitoring progress
   */
  async trackGoal(goalId: string, steps: string[]): Promise<GoalTrackingResult> {
    this.logger.info('Starting goal tracking', { goalId, steps });
    return this.goals.trackGoal(goalId, steps);
  }

  /**
   * Assess a response with metacognitive analysis
   * Convenience method that wraps metacognition.assessResponse
   *
   * @param response - The response to assess
   * @param confidence - Confidence level (0-1)
   * @returns MetacognitionAssessment with suggestions
   */
  async assessResponse(response: string, confidence: number): Promise<MetacognitionAssessment> {
    this.logger.debug('Assessing response with metacognition', { confidence });
    return this.metacognition.assessResponse(response, confidence);
  }
}
