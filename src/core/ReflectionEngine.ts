/**
 * RecallBricks Agent Runtime - Reflection Engine
 *
 * Enables agent self-analysis and metacognition
 * Triggers reflections based on conditions like task completion,
 * low confidence, or detected contradictions
 */

import { LLMAdapter } from './LLMAdapter';
import { RecallBricksClient } from '../api/RecallBricksClient';
import {
  Memory,
  ConversationTurn,
  Logger,
  LLMMessage,
  AgentStateEntry,
} from '../types';

// ============================================================================
// Reflection Types
// ============================================================================

export interface Reflection {
  id: string;
  type: ReflectionType;
  content: string;
  insights: string[];
  confidence: number;
  timestamp: string;
  triggerCondition: ReflectionTrigger;
  relatedMemories: string[];
}

export type ReflectionType =
  | 'task_completion'
  | 'low_confidence'
  | 'contradiction'
  | 'pattern_recognition'
  | 'self_improvement'
  | 'periodic';

export type ReflectionTrigger =
  | 'task_complete'
  | 'confidence_below_threshold'
  | 'contradiction_detected'
  | 'interaction_count'
  | 'manual';

export interface ReflectionEngineConfig {
  llmAdapter: LLMAdapter;
  apiClient: RecallBricksClient;
  agentId: string;
  agentName: string;
  reflectionInterval: number; // Number of interactions before reflection
  confidenceThreshold: number; // Trigger reflection if below this
  logger: Logger;
}

export interface ReasoningTrace {
  query: string;
  steps: ReasoningStep[];
  conclusion: string;
  confidence: number;
  memoryReferences: string[];
  stateReferences?: string[];
}

export interface ReasoningStep {
  thought: string;
  observation?: string;
  action?: string;
}

// ============================================================================
// Reflection Engine Implementation
// ============================================================================

export class ReflectionEngine {
  private interactionCount = 0;
  private recentTurns: ConversationTurn[] = [];
  private reflectionHistory: Reflection[] = [];
  private pendingContradictions: Array<{ memory1: Memory; memory2: Memory }> = [];

  constructor(private config: ReflectionEngineConfig) {
    config.logger.debug('ReflectionEngine initialized', {
      reflectionInterval: config.reflectionInterval,
      confidenceThreshold: config.confidenceThreshold,
    });
  }

  /**
   * Record an interaction for reflection tracking
   */
  recordInteraction(turn: ConversationTurn, confidence?: number): void {
    this.interactionCount++;
    this.recentTurns.push(turn);

    // Keep only last 10 turns for context
    if (this.recentTurns.length > 10) {
      this.recentTurns.shift();
    }

    this.config.logger.debug('Interaction recorded', {
      count: this.interactionCount,
      confidence,
    });
  }

  /**
   * Check if reflection should be triggered
   */
  shouldReflect(context?: {
    taskComplete?: boolean;
    confidence?: number;
    contradictionDetected?: boolean;
  }): { shouldReflect: boolean; trigger?: ReflectionTrigger } {
    // Task completion trigger
    if (context?.taskComplete) {
      return { shouldReflect: true, trigger: 'task_complete' };
    }

    // Low confidence trigger
    if (
      context?.confidence !== undefined &&
      context.confidence < this.config.confidenceThreshold
    ) {
      return { shouldReflect: true, trigger: 'confidence_below_threshold' };
    }

    // Contradiction trigger
    if (context?.contradictionDetected || this.pendingContradictions.length > 0) {
      return { shouldReflect: true, trigger: 'contradiction_detected' };
    }

    // Periodic trigger based on interaction count
    if (this.interactionCount >= this.config.reflectionInterval) {
      return { shouldReflect: true, trigger: 'interaction_count' };
    }

    return { shouldReflect: false };
  }

  /**
   * Perform a reflection analysis
   */
  async reflect(trigger: ReflectionTrigger = 'manual'): Promise<Reflection> {
    this.config.logger.info('Starting reflection', { trigger });

    const startTime = Date.now();

    // Build reflection prompt based on trigger
    const prompt = this.buildReflectionPrompt(trigger);

    // Call LLM for reflection
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are ${this.config.agentName}'s metacognition module. Analyze the recent interactions and provide insights for self-improvement. Be concise and actionable.`,
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    const llmResponse = await this.config.llmAdapter.chat(messages);
    const reflectionContent = llmResponse.content;

    // Parse insights from reflection
    const insights = this.extractInsights(reflectionContent);

    // Estimate confidence based on reflection clarity
    const confidence = this.estimateConfidence(reflectionContent, insights);

    const reflection: Reflection = {
      id: `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: this.getReflectionType(trigger),
      content: reflectionContent,
      insights,
      confidence,
      timestamp: new Date().toISOString(),
      triggerCondition: trigger,
      relatedMemories: this.recentTurns.slice(-3).map((t) => t.userMessage.slice(0, 50)),
    };

    // Save reflection as a memory
    await this.saveReflectionAsMemory(reflection);

    // Reset counters
    this.interactionCount = 0;
    this.pendingContradictions = [];

    // Add to history
    this.reflectionHistory.push(reflection);
    if (this.reflectionHistory.length > 20) {
      this.reflectionHistory.shift();
    }

    const duration = Date.now() - startTime;
    this.config.logger.info('Reflection completed', {
      duration: `${duration}ms`,
      insights: insights.length,
      confidence,
    });

    return reflection;
  }

  /**
   * Explain reasoning for a query (Chain of Thought)
   */
  async explain(query: string, memories: Memory[]): Promise<ReasoningTrace> {
    this.config.logger.debug('Generating reasoning trace', { query });

    // Format memories for context
    const memoryContext = memories
      .slice(0, 5)
      .map((m, i) => `[${i + 1}] ${m.content}`)
      .join('\n');

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are ${this.config.agentName}. Think step by step to answer the query. For each step, provide your thought process. Reference relevant memories by their number.`,
      },
      {
        role: 'user',
        content: `Query: ${query}\n\nRelevant memories:\n${memoryContext}\n\nThink through this step by step:`,
      },
    ];

    const llmResponse = await this.config.llmAdapter.chat(messages);
    const reasoning = llmResponse.content;

    // Parse reasoning into steps
    const steps = this.parseReasoningSteps(reasoning);

    // Extract conclusion
    const conclusion = this.extractConclusion(reasoning);

    // Calculate confidence based on memory references and step clarity
    const memoryRefs = this.extractMemoryReferences(reasoning);
    const confidence = Math.min(
      1,
      0.5 + steps.length * 0.1 + memoryRefs.length * 0.1
    );

    return {
      query,
      steps,
      conclusion,
      confidence,
      memoryReferences: memoryRefs,
    };
  }

  /**
   * Build a reasoning trace from agent state entries — no LLM call needed.
   *
   * "I attempted X because of Y. It failed due to Z. I learned Q.
   *  Current directive: do not retry prior path. Next approach: W."
   */
  explainFromState(query: string, stateEntries: AgentStateEntry[]): ReasoningTrace {
    this.config.logger.debug('Building reasoning trace from state entries', {
      query,
      entryCount: stateEntries.length,
    });

    if (stateEntries.length === 0) {
      return {
        query,
        steps: [{ thought: 'No prior state entries found for this agent.' }],
        conclusion: 'No operational history available to explain.',
        confidence: 0.3,
        memoryReferences: [],
        stateReferences: [],
      };
    }

    // Sort entries chronologically
    const sorted = [...stateEntries].sort(
      (a, b) => new Date(a.timestamp || '').getTime() - new Date(b.timestamp || '').getTime()
    );

    // Build reasoning steps from state entries
    const steps: ReasoningStep[] = [];
    const stateRefs: string[] = [];

    for (const entry of sorted) {
      if (entry.id) stateRefs.push(entry.id);

      const toolInfo = entry.tool_name ? ` (tool: ${entry.tool_name})` : '';
      const step: ReasoningStep = {
        thought: `I attempted "${entry.goal}" by ${entry.action}${toolInfo}`,
        observation: `Outcome: ${entry.outcome} — ${entry.result || 'no result recorded'}`,
      };

      if (entry.lesson) {
        step.action = `Lesson learned: ${entry.lesson}`;
      }

      steps.push(step);
    }

    // Build conclusion from the most recent active entries
    const failures = sorted.filter(e => e.outcome === 'failure');
    const latestEntry = sorted[sorted.length - 1];

    let conclusion = '';

    if (failures.length > 0) {
      const lastFailure = failures[failures.length - 1];
      conclusion += `I attempted "${lastFailure.goal}" and it failed: ${lastFailure.result || 'unknown error'}. `;
      if (lastFailure.lesson) {
        conclusion += `I learned: ${lastFailure.lesson}. `;
      }
    }

    if (!conclusion) {
      conclusion = `Last action: "${latestEntry.goal}" — ${latestEntry.outcome}: ${latestEntry.result || 'completed'}`;
    }

    // Calculate confidence based on number of entries
    const confidence = Math.min(1, 0.5 + steps.length * 0.05);

    return {
      query,
      steps,
      conclusion: conclusion.trim(),
      confidence,
      memoryReferences: [],
      stateReferences: stateRefs,
    };
  }

  /**
   * Detect potential contradictions between memories
   */
  detectContradiction(memory1: Memory, memory2: Memory): boolean {
    // Simple heuristic: check for opposing keywords
    const opposingPairs = [
      ['love', 'hate'],
      ['like', 'dislike'],
      ['yes', 'no'],
      ['always', 'never'],
      ['true', 'false'],
      ['good', 'bad'],
      ['want', "don't want"],
      ['prefer', "don't prefer"],
    ];

    const content1 = memory1.content.toLowerCase();
    const content2 = memory2.content.toLowerCase();

    for (const [word1, word2] of opposingPairs) {
      if (
        (content1.includes(word1) && content2.includes(word2)) ||
        (content1.includes(word2) && content2.includes(word1))
      ) {
        // Check if they're about the same topic (simple overlap check)
        const words1 = new Set(content1.split(/\s+/));
        const words2 = new Set(content2.split(/\s+/));
        const overlap = [...words1].filter((w) => words2.has(w) && w.length > 3);

        if (overlap.length >= 2) {
          this.pendingContradictions.push({ memory1, memory2 });
          this.config.logger.warn('Potential contradiction detected', {
            overlap,
          });
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get reflection history
   */
  getReflectionHistory(): Reflection[] {
    return [...this.reflectionHistory];
  }

  /**
   * Get pending contradictions
   */
  getPendingContradictions(): Array<{ memory1: Memory; memory2: Memory }> {
    return [...this.pendingContradictions];
  }

  /**
   * Build reflection prompt based on trigger type
   */
  private buildReflectionPrompt(trigger: ReflectionTrigger): string {
    const recentContext = this.recentTurns
      .slice(-5)
      .map(
        (t) =>
          `User: ${t.userMessage.slice(0, 100)}...\nAssistant: ${t.assistantResponse.slice(0, 100)}...`
      )
      .join('\n\n');

    let prompt = `Reflect on these recent interactions:\n\n${recentContext}\n\n`;

    switch (trigger) {
      case 'task_complete':
        prompt +=
          'The user has indicated task completion. Reflect on:\n' +
          '1. What was accomplished?\n' +
          '2. What could have been done better?\n' +
          '3. What should I remember for future similar tasks?';
        break;

      case 'confidence_below_threshold':
        prompt +=
          'I detected low confidence in my responses. Reflect on:\n' +
          '1. Why was my confidence low?\n' +
          '2. What information was missing?\n' +
          '3. How can I improve for similar questions?';
        break;

      case 'contradiction_detected':
        const contradictions = this.pendingContradictions
          .slice(0, 3)
          .map(
            (c) =>
              `Memory 1: "${c.memory1.content.slice(0, 50)}..."\n` +
              `Memory 2: "${c.memory2.content.slice(0, 50)}..."`
          )
          .join('\n\n');
        prompt +=
          `Contradictions detected in my memory:\n${contradictions}\n\n` +
          'Reflect on:\n' +
          '1. Which information is more recent/reliable?\n' +
          '2. How should I reconcile these?\n' +
          '3. What questions should I ask to clarify?';
        break;

      case 'interaction_count':
      case 'manual':
      default:
        prompt +=
          'Periodic self-reflection. Consider:\n' +
          '1. What patterns do I notice in user needs?\n' +
          '2. What have I learned that should be remembered?\n' +
          '3. How can I be more helpful?';
    }

    return prompt;
  }

  /**
   * Extract insights from reflection content
   */
  private extractInsights(content: string): string[] {
    const insights: string[] = [];

    // Look for numbered lists or bullet points
    const listMatches = content.match(/(?:\d+\.|[-•*])\s*([^\n]+)/g);
    if (listMatches) {
      insights.push(
        ...listMatches.map((m) => m.replace(/^(?:\d+\.|[-•*])\s*/, '').trim())
      );
    }

    // Look for sentences with insight keywords
    const sentences = content.split(/[.!?]+/);
    const insightKeywords = [
      'should',
      'could',
      'need to',
      'important',
      'remember',
      'notice',
      'pattern',
      'improve',
      'better',
      'learn',
    ];

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (
        trimmed.length > 20 &&
        insightKeywords.some((k) => trimmed.toLowerCase().includes(k)) &&
        !insights.includes(trimmed)
      ) {
        insights.push(trimmed);
      }
    }

    return insights.slice(0, 5); // Limit to top 5 insights
  }

  /**
   * Estimate confidence from reflection quality
   */
  private estimateConfidence(content: string, insights: string[]): number {
    let confidence = 0.5;

    // More insights = higher confidence
    confidence += Math.min(insights.length * 0.1, 0.3);

    // Longer, more detailed reflection = higher confidence
    if (content.length > 500) confidence += 0.1;
    if (content.length > 1000) confidence += 0.05;

    // Structured response = higher confidence
    if (content.includes('1.') || content.includes('-')) confidence += 0.05;

    return Math.min(confidence, 1);
  }

  /**
   * Get reflection type from trigger
   */
  private getReflectionType(trigger: ReflectionTrigger): ReflectionType {
    switch (trigger) {
      case 'task_complete':
        return 'task_completion';
      case 'confidence_below_threshold':
        return 'low_confidence';
      case 'contradiction_detected':
        return 'contradiction';
      case 'interaction_count':
        return 'periodic';
      default:
        return 'self_improvement';
    }
  }

  /**
   * Save reflection as a memory
   */
  private async saveReflectionAsMemory(reflection: Reflection): Promise<void> {
    try {
      await this.config.apiClient.saveMemory({
        text: `[Reflection - ${reflection.type}] ${reflection.content}`,
        tags: ['reflection', reflection.type],
        source: 'reflection-engine',
        metadata: {
          reflectionId: reflection.id,
          insights: reflection.insights,
          confidence: reflection.confidence,
        },
      });
      this.config.logger.debug('Reflection saved as memory');
    } catch (error) {
      this.config.logger.warn('Failed to save reflection as memory', { error });
    }
  }

  /**
   * Parse reasoning into steps
   */
  private parseReasoningSteps(reasoning: string): ReasoningStep[] {
    const steps: ReasoningStep[] = [];

    // Look for numbered steps or "Step X:" patterns
    const stepPatterns = [
      /(?:Step\s*\d+[:.]\s*|(?:\d+)[.)]\s*)([^\n]+(?:\n(?![Ss]tep|\d+[.)]).*)*)/g,
      /(?:First|Second|Third|Fourth|Fifth|Then|Next|Finally)[,:]?\s*([^\n]+)/gi,
    ];

    for (const pattern of stepPatterns) {
      let match;
      while ((match = pattern.exec(reasoning)) !== null) {
        steps.push({
          thought: match[1].trim(),
        });
      }
    }

    // If no structured steps found, split by sentences
    if (steps.length === 0) {
      const sentences = reasoning.split(/[.!?]+/).filter((s) => s.trim().length > 20);
      for (const sentence of sentences.slice(0, 5)) {
        steps.push({ thought: sentence.trim() });
      }
    }

    return steps;
  }

  /**
   * Extract conclusion from reasoning
   */
  private extractConclusion(reasoning: string): string {
    // Look for conclusion markers
    const conclusionPatterns = [
      /(?:Therefore|Thus|In conclusion|So|Finally|The answer is)[,:]?\s*([^.]+\.)/i,
      /(?:Based on|Given|Considering)[^.]+,\s*([^.]+\.)/i,
    ];

    for (const pattern of conclusionPatterns) {
      const match = reasoning.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }

    // Default: last sentence
    const sentences = reasoning.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    return sentences[sentences.length - 1]?.trim() || reasoning.slice(-200);
  }

  /**
   * Extract memory references from reasoning
   */
  private extractMemoryReferences(reasoning: string): string[] {
    const refs: string[] = [];

    // Look for [1], [2], etc. references
    const refMatches = reasoning.match(/\[(\d+)\]/g);
    if (refMatches) {
      refs.push(...refMatches.map((r) => r.slice(1, -1)));
    }

    // Look for "memory 1", "first memory", etc.
    const wordRefs = reasoning.match(/(?:memory|fact|observation)\s*(\d+)/gi);
    if (wordRefs) {
      refs.push(
        ...wordRefs.map((r) => r.match(/\d+/)?.[0] || '').filter(Boolean)
      );
    }

    return [...new Set(refs)];
  }
}
