/**
 * Tests for Agent State Tracking
 *
 * Covers:
 * - State extraction from conversation turns (AutoSaver)
 * - Deterministic state context loading (ContextWeaver)
 * - Explain from state entries (ReflectionEngine)
 * - State API client methods (RecallBricksClient)
 */

import { AutoSaver } from '../src/core/AutoSaver';
import { ContextWeaver } from '../src/core/ContextWeaver';
import { ReflectionEngine } from '../src/core/ReflectionEngine';
import { RecallBricksClient } from '../src/api/RecallBricksClient';
import { ConversationTurn, Logger, AgentStateEntry } from '../src/types';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock RecallBricksClient
jest.mock('../src/api/RecallBricksClient');
const MockedRecallBricksClient = RecallBricksClient as jest.MockedClass<typeof RecallBricksClient>;

// Mock LLM adapter
jest.mock('../src/core/LLMAdapter');

const mockLogger: Logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// ============================================================================
// AutoSaver State Extraction Tests
// ============================================================================

describe('AutoSaver State Extraction', () => {
  let autoSaver: AutoSaver;
  let mockAxiosInstance: any;

  beforeEach(() => {
    mockAxiosInstance = {
      get: jest.fn().mockResolvedValue({ data: {} }),
      post: jest.fn().mockResolvedValue({
        data: { id: 'mem_123', text: 'test', user_id: 'u1', created_at: new Date().toISOString() },
      }),
      defaults: { headers: {} },
      interceptors: { response: { use: jest.fn() } },
    };
    mockedAxios.create.mockReturnValue(mockAxiosInstance);
    (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(false);

    autoSaver = new AutoSaver({
      apiUrl: 'https://api.test.com',
      apiKey: 'test_key',
      agentId: 'agent_001',
      userId: 'user_001',
      tier: 'starter',
      logger: mockLogger,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('extractStateEntry', () => {
    it('should extract a state entry from a successful turn', () => {
      const turn: ConversationTurn = {
        userMessage: 'Create a new user account',
        assistantResponse: 'I created the user account successfully. The new account has been set up with default permissions.',
        timestamp: new Date().toISOString(),
      };

      const entry = autoSaver.extractStateEntry(turn);

      expect(entry).toBeDefined();
      expect(entry.agent_id).toBe('agent_001');
      expect(entry.outcome).toBe('success');
      expect(entry.active).toBe(true);
      expect(entry.id).toMatch(/^state_/);
      expect(entry.goal).toBeTruthy();
      expect(entry.action).toBeTruthy();
      expect(entry.result_summary).toBeTruthy();
      expect(entry.confidence).toBeGreaterThan(0);
    });

    it('should detect failure outcome', () => {
      const turn: ConversationTurn = {
        userMessage: 'Deploy the application',
        assistantResponse: 'Unfortunately, I was unable to deploy the application. The deployment failed due to a missing configuration file.',
        timestamp: new Date().toISOString(),
      };

      const entry = autoSaver.extractStateEntry(turn);

      expect(entry.outcome).toBe('failure');
      expect(entry.lesson).toBeTruthy(); // Should extract a lesson from failure
    });

    it('should detect partial outcome', () => {
      const turn: ConversationTurn = {
        userMessage: 'Update all dependencies',
        assistantResponse: 'I updated most dependencies, however some issues remain. Not fully completed due to version conflicts.',
        timestamp: new Date().toISOString(),
      };

      const entry = autoSaver.extractStateEntry(turn);

      expect(entry.outcome).toBe('partial');
    });

    it('should detect deferred outcome', () => {
      const turn: ConversationTurn = {
        userMessage: 'Configure the database',
        assistantResponse: 'I need more information to proceed. Could you clarify which database engine to use?',
        timestamp: new Date().toISOString(),
      };

      const entry = autoSaver.extractStateEntry(turn);

      expect(entry.outcome).toBe('deferred');
    });

    it('should extract constraints from responses', () => {
      const turn: ConversationTurn = {
        userMessage: 'Access the admin panel',
        assistantResponse: 'I cannot access the admin panel due to insufficient permissions. This requires admin-level access.',
        timestamp: new Date().toISOString(),
      };

      const entry = autoSaver.extractStateEntry(turn);

      expect(entry.constraint_discovered).toBeTruthy();
    });

    it('should extract recommendations from responses', () => {
      const turn: ConversationTurn = {
        userMessage: 'How should I structure the API?',
        assistantResponse: 'I recommend using a RESTful design with versioned endpoints for better maintainability.',
        timestamp: new Date().toISOString(),
      };

      const entry = autoSaver.extractStateEntry(turn);

      expect(entry.recommendation).toBeTruthy();
    });

    it('should use tool context when provided', () => {
      const turn: ConversationTurn = {
        userMessage: 'Search for user records',
        assistantResponse: 'Found 15 matching records.',
        timestamp: new Date().toISOString(),
      };

      const entry = autoSaver.extractStateEntry(turn, {
        toolsUsed: [{ name: 'database_search', result: 'Found 15 records' }],
      });

      expect(entry.action).toContain('tool:database_search');
      expect(entry.outcome).toBe('success');
    });

    it('should detect tool failures', () => {
      const turn: ConversationTurn = {
        userMessage: 'Delete the file',
        assistantResponse: 'The file deletion was attempted.',
        timestamp: new Date().toISOString(),
      };

      const entry = autoSaver.extractStateEntry(turn, {
        toolsUsed: [{ name: 'file_delete', result: 'error: permission denied' }],
      });

      expect(entry.outcome).toBe('failure');
    });

    it('should use reflection output as reasoning', () => {
      const turn: ConversationTurn = {
        userMessage: 'Analyze this data',
        assistantResponse: 'The analysis shows a clear trend.',
        timestamp: new Date().toISOString(),
      };

      const entry = autoSaver.extractStateEntry(turn, {
        reflectionOutput: 'Previous attempts showed the data has seasonal patterns',
      });

      expect(entry.reasoning).toContain('seasonal patterns');
    });

    it('should increment turn number', () => {
      const turn1: ConversationTurn = {
        userMessage: 'First message',
        assistantResponse: 'First response',
        timestamp: new Date().toISOString(),
      };
      const turn2: ConversationTurn = {
        userMessage: 'Second message',
        assistantResponse: 'Second response',
        timestamp: new Date().toISOString(),
      };

      const entry1 = autoSaver.extractStateEntry(turn1);
      const entry2 = autoSaver.extractStateEntry(turn2);

      expect((entry1.state_before as Record<string, number>).turn_number).toBe(0);
      expect((entry2.state_before as Record<string, number>).turn_number).toBe(1);
    });
  });

  describe('supersession', () => {
    it('should mark old entry as inactive when new entry has same goal', () => {
      const turn1: ConversationTurn = {
        userMessage: 'Deploy the application to staging',
        assistantResponse: 'Unfortunately, I failed to deploy to staging. The server returned an error.',
        timestamp: new Date().toISOString(),
      };
      const turn2: ConversationTurn = {
        userMessage: 'Deploy the application to staging again',
        assistantResponse: 'I successfully deployed the application to staging this time.',
        timestamp: new Date().toISOString(),
      };

      const entry1 = autoSaver.extractStateEntry(turn1);
      expect(entry1.active).toBe(true);

      const entry2 = autoSaver.extractStateEntry(turn2);
      expect(entry2.active).toBe(true);

      // entry1 should now be superseded
      const allEntries = autoSaver.getStateEntries();
      const oldEntry = allEntries.find(e => e.id === entry1.id);
      expect(oldEntry?.active).toBe(false);
      expect(oldEntry?.superseded_by).toBe(entry2.id);
    });
  });

  describe('getStateEntries / getActiveStateEntries', () => {
    it('should return all entries', () => {
      const turn: ConversationTurn = {
        userMessage: 'Test',
        assistantResponse: 'Response',
        timestamp: new Date().toISOString(),
      };

      autoSaver.extractStateEntry(turn);
      autoSaver.extractStateEntry(turn);

      expect(autoSaver.getStateEntries().length).toBe(2);
    });

    it('should filter to active entries only', () => {
      const turn1: ConversationTurn = {
        userMessage: 'Deploy the application to staging',
        assistantResponse: 'Failed to deploy. Error occurred.',
        timestamp: new Date().toISOString(),
      };
      const turn2: ConversationTurn = {
        userMessage: 'Deploy the application to staging',
        assistantResponse: 'Successfully deployed the application.',
        timestamp: new Date().toISOString(),
      };

      autoSaver.extractStateEntry(turn1);
      autoSaver.extractStateEntry(turn2);

      const active = autoSaver.getActiveStateEntries();
      // The second entry supersedes the first — only one should be active
      expect(active.length).toBe(1);
    });
  });

  describe('updateExtractionContext', () => {
    it('should update session goals', () => {
      autoSaver.updateExtractionContext({
        sessionGoals: ['build API', 'write tests'],
      });

      const turn: ConversationTurn = {
        userMessage: 'Check status',
        assistantResponse: 'Everything is running.',
        timestamp: new Date().toISOString(),
      };

      const entry = autoSaver.extractStateEntry(turn);
      const stateBefore = entry.state_before as Record<string, string[]>;
      expect(stateBefore.active_goals).toContain('build API');
    });
  });
});

// ============================================================================
// ContextWeaver State Context Tests
// ============================================================================

describe('ContextWeaver State Context', () => {
  let contextWeaver: ContextWeaver;
  let mockApiClient: jest.Mocked<RecallBricksClient>;

  beforeEach(() => {
    mockApiClient = new MockedRecallBricksClient({
      apiUrl: 'https://api.test.com',
      apiKey: 'test_key',
      userId: 'test_user',
    }) as jest.Mocked<RecallBricksClient>;

    mockApiClient.getAgentState = jest.fn().mockResolvedValue({
      entries: [
        {
          id: 'state_1',
          agent_id: 'agent_001',
          timestamp: new Date().toISOString(),
          goal: 'build API',
          action: 'created endpoint',
          reasoning: 'user requested REST API',
          outcome: 'success',
          result_summary: 'API endpoint created',
          lesson: null,
          constraint_discovered: null,
          state_before: {},
          state_after: { endpoints: 3 },
          override: null,
          recommendation: 'add authentication next',
          confidence: 0.8,
          superseded_by: null,
          active: true,
        },
        {
          id: 'state_2',
          agent_id: 'agent_001',
          timestamp: new Date(Date.now() - 10000).toISOString(),
          goal: 'deploy to prod',
          action: 'attempted deployment',
          reasoning: 'deployment requested',
          outcome: 'failure',
          result_summary: 'Deployment failed: missing env vars',
          lesson: 'Always check env vars before deployment',
          constraint_discovered: 'requires ENV_SECRET to be set',
          state_before: {},
          state_after: {},
          override: null,
          recommendation: null,
          confidence: 0.6,
          superseded_by: null,
          active: true,
        },
      ] as AgentStateEntry[],
      total: 2,
    });

    // Also mock recallMemories for fallback buildContext
    mockApiClient.recallMemories = jest.fn().mockResolvedValue({
      memories: [],
      total: 0,
    });

    contextWeaver = new ContextWeaver({
      apiClient: mockApiClient,
      agentId: 'agent_001',
      agentName: 'TestBot',
      agentPurpose: 'Testing',
      maxContextMemories: 10,
      maxContextTokens: 4000,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('buildStateContext', () => {
    it('should build state context from API entries', async () => {
      const ctx = await contextWeaver.buildStateContext();

      expect(ctx).toBeDefined();
      expect(ctx.identity.id).toBe('agent_001');
      expect(ctx.stateEntries.length).toBe(2);
      expect(ctx.operationalState.activeGoals.length).toBeGreaterThan(0);
      expect(ctx.systemPrompt).toContain('AGENT OPERATIONAL STATE');
    });

    it('should include discovered constraints', async () => {
      const ctx = await contextWeaver.buildStateContext();

      expect(ctx.operationalState.activeConstraints).toContain('requires ENV_SECRET to be set');
      expect(ctx.systemPrompt).toContain('Active constraints');
    });

    it('should include recent failures with lessons', async () => {
      const ctx = await contextWeaver.buildStateContext();

      expect(ctx.operationalState.recentFailures.length).toBe(1);
      expect(ctx.operationalState.recentFailures[0].lesson).toContain('env vars');
    });

    it('should include directives (recommendations)', async () => {
      const ctx = await contextWeaver.buildStateContext();

      expect(ctx.operationalState.directives.length).toBeGreaterThan(0);
      expect(ctx.operationalState.directives[0].content).toContain('authentication');
    });

    it('should merge local entries with API entries', async () => {
      const localEntry: AgentStateEntry = {
        id: 'local_1',
        agent_id: 'agent_001',
        timestamp: new Date().toISOString(),
        goal: 'local task',
        action: 'local action',
        reasoning: 'local reasoning',
        outcome: 'success',
        result_summary: 'done locally',
        lesson: null,
        constraint_discovered: null,
        state_before: {},
        state_after: {},
        override: null,
        recommendation: null,
        confidence: 0.7,
        superseded_by: null,
        active: true,
      };

      const ctx = await contextWeaver.buildStateContext([localEntry]);

      expect(ctx.stateEntries.length).toBe(3); // 2 from API + 1 local
    });

    it('should deduplicate entries by id', async () => {
      const duplicateEntry: AgentStateEntry = {
        id: 'state_1', // same as API entry
        agent_id: 'agent_001',
        timestamp: new Date().toISOString(),
        goal: 'build API',
        action: 'created endpoint',
        reasoning: 'duplicate',
        outcome: 'success',
        result_summary: 'duplicate',
        lesson: null,
        constraint_discovered: null,
        state_before: {},
        state_after: {},
        override: null,
        recommendation: null,
        confidence: 0.8,
        superseded_by: null,
        active: true,
      };

      const ctx = await contextWeaver.buildStateContext([duplicateEntry]);

      // Should not add duplicate
      expect(ctx.stateEntries.length).toBe(2);
    });

    it('should handle API failure gracefully using local entries', async () => {
      mockApiClient.getAgentState = jest.fn().mockRejectedValue(new Error('Network error'));

      const localEntry: AgentStateEntry = {
        id: 'local_only',
        agent_id: 'agent_001',
        timestamp: new Date().toISOString(),
        goal: 'offline task',
        action: 'offline action',
        reasoning: 'offline reasoning',
        outcome: 'success',
        result_summary: 'done offline',
        lesson: null,
        constraint_discovered: null,
        state_before: {},
        state_after: {},
        override: null,
        recommendation: null,
        confidence: 0.5,
        superseded_by: null,
        active: true,
      };

      const ctx = await contextWeaver.buildStateContext([localEntry]);

      expect(ctx.stateEntries.length).toBe(1);
      expect(ctx.stateEntries[0].id).toBe('local_only');
    });

    it('should format system prompt with identity and state', async () => {
      const ctx = await contextWeaver.buildStateContext();

      expect(ctx.systemPrompt).toContain('TestBot');
      expect(ctx.systemPrompt).toContain('AGENT OPERATIONAL STATE');
      expect(ctx.systemPrompt).toContain('Behavioral guidelines');
    });
  });

  describe('getLastStateContext', () => {
    it('should return undefined before first build', () => {
      expect(contextWeaver.getLastStateContext()).toBeUndefined();
    });

    it('should return last built state context', async () => {
      await contextWeaver.buildStateContext();
      const last = contextWeaver.getLastStateContext();

      expect(last).toBeDefined();
      expect(last?.stateEntries.length).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// ReflectionEngine explainFromState Tests
// ============================================================================

describe('ReflectionEngine explainFromState', () => {
  let reflectionEngine: ReflectionEngine;
  let mockApiClient: jest.Mocked<RecallBricksClient>;

  beforeEach(() => {
    mockApiClient = new MockedRecallBricksClient({
      apiUrl: 'https://api.test.com',
      apiKey: 'test_key',
      userId: 'test_user',
    }) as jest.Mocked<RecallBricksClient>;

    mockApiClient.saveMemory = jest.fn().mockResolvedValue({
      id: 'mem_1',
      text: 'test',
      user_id: 'u1',
      created_at: new Date().toISOString(),
    });

    // Create a mock LLM adapter
    const mockLlmAdapter = {
      chat: jest.fn().mockResolvedValue({
        content: 'Test reflection',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
      }),
      updateConfig: jest.fn(),
    } as any;

    reflectionEngine = new ReflectionEngine({
      llmAdapter: mockLlmAdapter,
      apiClient: mockApiClient,
      agentId: 'agent_001',
      agentName: 'TestBot',
      reflectionInterval: 5,
      confidenceThreshold: 0.6,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should build reasoning trace from state entries', () => {
    const entries: AgentStateEntry[] = [
      {
        id: 'state_1',
        agent_id: 'agent_001',
        timestamp: new Date(Date.now() - 20000).toISOString(),
        goal: 'deploy to prod',
        action: 'ran deploy command',
        reasoning: 'user requested deployment',
        outcome: 'failure',
        result_summary: 'Missing environment variables',
        lesson: 'Always verify env vars first',
        constraint_discovered: 'requires PROD_KEY',
        state_before: {},
        state_after: {},
        override: null,
        recommendation: 'check env vars before next attempt',
        confidence: 0.5,
        superseded_by: null,
        active: true,
      },
      {
        id: 'state_2',
        agent_id: 'agent_001',
        timestamp: new Date().toISOString(),
        goal: 'deploy to prod',
        action: 'ran deploy command with env vars',
        reasoning: 'retry with correct config',
        outcome: 'success',
        result_summary: 'Deployment successful',
        lesson: null,
        constraint_discovered: null,
        state_before: {},
        state_after: { deployed: true },
        override: null,
        recommendation: null,
        confidence: 0.9,
        superseded_by: null,
        active: true,
      },
    ];

    const trace = reflectionEngine.explainFromState('Why did deployment fail initially?', entries);

    expect(trace.query).toBe('Why did deployment fail initially?');
    expect(trace.steps.length).toBe(2);
    expect(trace.steps[0].thought).toContain('deploy to prod');
    expect(trace.steps[0].observation).toContain('failure');
    expect(trace.steps[0].action).toContain('Always verify env vars');
    expect(trace.conclusion).toBeTruthy();
    expect(trace.stateReferences).toContain('state_1');
    expect(trace.stateReferences).toContain('state_2');
    expect(trace.confidence).toBeGreaterThan(0);
  });

  it('should return minimal trace when no entries exist', () => {
    const trace = reflectionEngine.explainFromState('What happened?', []);

    expect(trace.steps.length).toBe(1);
    expect(trace.conclusion).toContain('No operational history');
    expect(trace.confidence).toBe(0.3);
  });

  it('should include failure lessons in conclusion', () => {
    const entries: AgentStateEntry[] = [
      {
        id: 'state_f',
        agent_id: 'agent_001',
        timestamp: new Date().toISOString(),
        goal: 'parse CSV file',
        action: 'attempted CSV parsing',
        reasoning: 'user uploaded CSV',
        outcome: 'failure',
        result_summary: 'Invalid encoding detected',
        lesson: 'Check file encoding before parsing',
        constraint_discovered: null,
        state_before: {},
        state_after: {},
        override: null,
        recommendation: 'try UTF-8 conversion first',
        confidence: 0.4,
        superseded_by: null,
        active: true,
      },
    ];

    const trace = reflectionEngine.explainFromState('Why did parsing fail?', entries);

    expect(trace.conclusion).toContain('parse CSV file');
    expect(trace.conclusion).toContain('Check file encoding');
  });

  it('should include directives in conclusion', () => {
    const entries: AgentStateEntry[] = [
      {
        id: 'state_d',
        agent_id: 'agent_001',
        timestamp: new Date().toISOString(),
        goal: 'handle request',
        action: 'processed request',
        reasoning: 'standard processing',
        outcome: 'success',
        result_summary: 'Done',
        lesson: null,
        constraint_discovered: null,
        state_before: {},
        state_after: {},
        override: 'Do not retry path X',
        recommendation: 'Use path Y instead',
        confidence: 0.8,
        superseded_by: null,
        active: true,
      },
    ];

    const trace = reflectionEngine.explainFromState('What should I do?', entries);

    expect(trace.conclusion).toContain('Do not retry path X');
    expect(trace.conclusion).toContain('Use path Y instead');
  });
});

// ============================================================================
// Confidence Calculation Tests (Phase 5)
// ============================================================================

describe('AutoSaver Confidence Calculation', () => {
  let autoSaver: AutoSaver;
  let mockAxiosInstance: any;

  beforeEach(() => {
    mockAxiosInstance = {
      get: jest.fn().mockResolvedValue({ data: {} }),
      post: jest.fn().mockResolvedValue({
        data: { id: 'mem_123', text: 'test', user_id: 'u1', created_at: new Date().toISOString() },
      }),
      defaults: { headers: {} },
      interceptors: { response: { use: jest.fn() } },
    };
    mockedAxios.create.mockReturnValue(mockAxiosInstance);
    (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(false);

    autoSaver = new AutoSaver({
      apiUrl: 'https://api.test.com',
      apiKey: 'test_key',
      agentId: 'agent_001',
      userId: 'user_001',
      tier: 'starter',
      logger: mockLogger,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should assign high confidence for successful outcomes', () => {
    const turn: ConversationTurn = {
      userMessage: 'Create a file',
      assistantResponse: 'I created the file successfully.',
      timestamp: new Date().toISOString(),
    };

    const entry = autoSaver.extractStateEntry(turn);
    expect(entry.outcome).toBe('success');
    expect(entry.confidence).toBe(0.8);
  });

  it('should assign low confidence for failure outcomes', () => {
    const turn: ConversationTurn = {
      userMessage: 'Deploy app',
      assistantResponse: 'Unfortunately, I was unable to deploy the application.',
      timestamp: new Date().toISOString(),
    };

    const entry = autoSaver.extractStateEntry(turn);
    expect(entry.outcome).toBe('failure');
    expect(entry.confidence).toBe(0.3);
  });

  it('should assign medium confidence for partial outcomes', () => {
    const turn: ConversationTurn = {
      userMessage: 'Update all files',
      assistantResponse: 'I updated some files, however they were not fully completed due to issues.',
      timestamp: new Date().toISOString(),
    };

    const entry = autoSaver.extractStateEntry(turn);
    expect(entry.outcome).toBe('partial');
    expect(entry.confidence).toBe(0.5);
  });

  it('should boost confidence when tools return results', () => {
    const turn: ConversationTurn = {
      userMessage: 'Search for records',
      assistantResponse: 'Found 15 matching records.',
      timestamp: new Date().toISOString(),
    };

    const entry = autoSaver.extractStateEntry(turn, {
      toolsUsed: [{ name: 'search', result: 'Found 15 records' }],
    });

    expect(entry.confidence).toBe(0.9); // 0.8 (success) + 0.1 (tool results)
  });

  it('should penalize confidence when uncertainty is expressed', () => {
    const turn: ConversationTurn = {
      userMessage: 'What caused the issue?',
      assistantResponse: 'I think the issue was caused by a network timeout, but I am not sure.',
      timestamp: new Date().toISOString(),
    };

    const entry = autoSaver.extractStateEntry(turn);
    expect(entry.confidence).toBeCloseTo(0.6, 5); // 0.8 (success) - 0.2 (uncertainty)
  });

  it('should clamp confidence to 0.0 minimum', () => {
    const turn: ConversationTurn = {
      userMessage: 'Fix the bug',
      assistantResponse: 'Unfortunately I failed. I think it might be a permission issue but I am not sure.',
      timestamp: new Date().toISOString(),
    };

    const entry = autoSaver.extractStateEntry(turn);
    expect(entry.confidence).toBeCloseTo(0.1, 5); // 0.3 (failure) - 0.2 (uncertainty)
  });
});

// ============================================================================
// ContextWeaver Token Capping Tests (Phase 4)
// ============================================================================

describe('ContextWeaver State Token Capping', () => {
  let contextWeaver: ContextWeaver;
  let mockApiClient: jest.Mocked<RecallBricksClient>;

  beforeEach(() => {
    mockApiClient = new MockedRecallBricksClient({
      apiUrl: 'https://api.test.com',
      apiKey: 'test_key',
      userId: 'test_user',
    }) as jest.Mocked<RecallBricksClient>;

    mockApiClient.recallMemories = jest.fn().mockResolvedValue({
      memories: [],
      total: 0,
    });

    contextWeaver = new ContextWeaver({
      apiClient: mockApiClient,
      agentId: 'agent_001',
      agentName: 'TestBot',
      agentPurpose: 'Testing',
      maxContextMemories: 10,
      maxContextTokens: 4000,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should trim goals when state context exceeds token limit', async () => {
    // Create many goals to exceed 500 token limit
    const entries: AgentStateEntry[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push({
        id: `state_${i}`,
        agent_id: 'agent_001',
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        goal: `Goal number ${i}: a fairly long goal description that takes up space in the context`,
        action: `action_${i}`,
        reasoning: 'testing',
        outcome: 'deferred' as const,
        result_summary: 'Pending',
        lesson: null,
        constraint_discovered: null,
        state_before: {},
        state_after: {},
        override: null,
        recommendation: null,
        confidence: 0.5,
        superseded_by: null,
        active: true,
      });
    }

    mockApiClient.getAgentState = jest.fn().mockResolvedValue({
      entries,
      total: entries.length,
    });

    const ctx = await contextWeaver.buildStateContext();

    // The prompt should still contain AGENT OPERATIONAL STATE
    expect(ctx.systemPrompt).toContain('AGENT OPERATIONAL STATE');
    // But should have fewer goals than the 50 we put in
    const goalLines = (ctx.systemPrompt.match(/^- Goal number/gm) || []).length;
    expect(goalLines).toBeLessThan(50);
  });

  it('should preserve directives and constraints during trimming', async () => {
    const entries: AgentStateEntry[] = [];

    // Add entries with directives and constraints
    entries.push({
      id: 'state_d',
      agent_id: 'agent_001',
      timestamp: new Date().toISOString(),
      goal: 'important task',
      action: 'action',
      reasoning: 'reasoning',
      outcome: 'success',
      result_summary: 'done',
      lesson: null,
      constraint_discovered: 'must not call production API',
      state_before: {},
      state_after: {},
      override: 'Do not retry path X',
      recommendation: 'Use path Y',
      confidence: 0.8,
      superseded_by: null,
      active: true,
    });

    // Add many filler entries to trigger trimming
    for (let i = 0; i < 40; i++) {
      entries.push({
        id: `filler_${i}`,
        agent_id: 'agent_001',
        timestamp: new Date(Date.now() - (i + 1) * 1000).toISOString(),
        goal: `filler goal ${i} with a long description to take up space`,
        action: 'filler action',
        reasoning: 'filler',
        outcome: 'failure' as const,
        result_summary: `Filler failure result summary for entry ${i}`,
        lesson: `Filler lesson for entry ${i}`,
        constraint_discovered: null,
        state_before: {},
        state_after: {},
        override: null,
        recommendation: null,
        confidence: 0.3,
        superseded_by: null,
        active: true,
      });
    }

    mockApiClient.getAgentState = jest.fn().mockResolvedValue({
      entries,
      total: entries.length,
    });

    const ctx = await contextWeaver.buildStateContext();

    // Directives and constraints should always be preserved
    expect(ctx.systemPrompt).toContain('must not call production API');
    expect(ctx.systemPrompt).toContain('Do not retry path X');
    expect(ctx.systemPrompt).toContain('Use path Y');
  });
});

