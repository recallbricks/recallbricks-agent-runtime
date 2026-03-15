/**
 * Tests for Agent State Tracking
 *
 * Covers:
 * - State extraction from conversation turns (AutoSaver)
 * - Deterministic state context loading (ContextWeaver)
 * - Explain from state entries (ReflectionEngine)
 * - CaptureMode behavior
 * - Explicit reporting methods
 */

import { AutoSaver } from '../src/core/AutoSaver';
import { ContextWeaver } from '../src/core/ContextWeaver';
import { ReflectionEngine } from '../src/core/ReflectionEngine';
import { RecallBricksClient } from '../src/api/RecallBricksClient';
import { ConversationTurn, Logger, AgentStateEntry } from '../src/types';
// Mock axios
jest.mock('axios');

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

  beforeEach(() => {
    autoSaver = new AutoSaver({
      apiUrl: 'https://api.test.com',
      apiKey: 'test_key',
      agentId: 'agent_001',
      userId: 'user_001',
      tier: 'starter',
      logger: mockLogger,
      captureMode: 'auto',
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
      expect(entry.result).toBeTruthy();
      expect(entry.source).toBe('auto');
    });

    it('should detect failure outcome', () => {
      const turn: ConversationTurn = {
        userMessage: 'Deploy the application',
        assistantResponse: 'Unfortunately, I was unable to deploy the application. The deployment failed due to a missing configuration file.',
        timestamp: new Date().toISOString(),
      };

      const entry = autoSaver.extractStateEntry(turn);

      expect(entry.outcome).toBe('failure');
      expect(entry.lesson).toBeTruthy();
    });

    it('should detect blocked outcome', () => {
      const turn: ConversationTurn = {
        userMessage: 'Call the production API',
        assistantResponse: '[BLOCKED] Action blocked by constraints: Never call production API',
        timestamp: new Date().toISOString(),
      };

      const entry = autoSaver.extractStateEntry(turn);

      expect(entry.outcome).toBe('blocked');
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
      expect(entry.tool_name).toBe('database_search');
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

    it('should generate failure_signature for failures', () => {
      const turn: ConversationTurn = {
        userMessage: 'Call the API',
        assistantResponse: 'The API call failed with error: connection refused.',
        timestamp: new Date().toISOString(),
      };

      const entry = autoSaver.extractStateEntry(turn);

      expect(entry.outcome).toBe('failure');
      expect(entry.failure_signature).toBeTruthy();
      expect(entry.seen_count).toBe(1);
      expect(entry.first_seen_at).toBeTruthy();
    });

    it('should extract error_code from tool results', () => {
      const turn: ConversationTurn = {
        userMessage: 'Send request',
        assistantResponse: 'Request failed.',
        timestamp: new Date().toISOString(),
      };

      const entry = autoSaver.extractStateEntry(turn, {
        toolsUsed: [{ name: 'http_client', result: 'error: 429 rate limited' }],
      });

      expect(entry.error_code).toBe('429');
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
      expect(entry).toBeDefined();
      expect(entry.outcome).toBe('success');
    });
  });
});

// ============================================================================
// CaptureMode Tests
// ============================================================================

describe('AutoSaver CaptureMode', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('captureMode=tools should only capture on error signals', () => {
    const autoSaver = new AutoSaver({
      apiUrl: 'https://api.test.com',
      apiKey: 'test_key',
      agentId: 'agent_001',
      userId: 'user_001',
      tier: 'starter',
      logger: mockLogger,
      captureMode: 'tools',
    });

    // Normal turn without error signals — should create minimal success entry
    const normalTurn: ConversationTurn = {
      userMessage: 'Hello',
      assistantResponse: 'Hi there! How can I help?',
      timestamp: new Date().toISOString(),
    };

    const normalEntry = autoSaver.extractStateEntry(normalTurn);
    expect(normalEntry.outcome).toBe('success');
    expect(normalEntry.source).toBe('auto');

    // Turn with error signal — should capture with full extraction
    const errorTurn: ConversationTurn = {
      userMessage: 'Call the API',
      assistantResponse: '[ERROR] HTTP 500 internal server error',
      timestamp: new Date().toISOString(),
    };

    const errorEntry = autoSaver.extractStateEntry(errorTurn);
    expect(errorEntry.outcome).toBeDefined();
    // Error signal detected, so full extraction runs
    expect(errorEntry.result).toBeTruthy();
  });

  it('captureMode=off should create minimal entries', () => {
    const autoSaver = new AutoSaver({
      apiUrl: 'https://api.test.com',
      apiKey: 'test_key',
      agentId: 'agent_001',
      userId: 'user_001',
      tier: 'starter',
      logger: mockLogger,
      captureMode: 'off',
    });

    const turn: ConversationTurn = {
      userMessage: 'Deploy the application',
      assistantResponse: 'Unfortunately, I was unable to deploy.',
      timestamp: new Date().toISOString(),
    };

    const entry = autoSaver.extractStateEntry(turn);
    expect(entry.outcome).toBe('success'); // 'off' mode always returns success
    expect(entry.action).toBe('generated response');
    expect(entry.source).toBe('auto');
  });

  it('captureMode=auto should use full heuristic extraction', () => {
    const autoSaver = new AutoSaver({
      apiUrl: 'https://api.test.com',
      apiKey: 'test_key',
      agentId: 'agent_001',
      userId: 'user_001',
      tier: 'starter',
      logger: mockLogger,
      captureMode: 'auto',
    });

    const turn: ConversationTurn = {
      userMessage: 'Deploy the application',
      assistantResponse: 'Unfortunately, I was unable to deploy. The server returned an error.',
      timestamp: new Date().toISOString(),
    };

    const entry = autoSaver.extractStateEntry(turn);
    expect(entry.outcome).toBe('failure');
    expect(entry.lesson).toBeTruthy();
    expect(entry.result).toBeTruthy();
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
          outcome: 'success',
          result: 'API endpoint created',
          tool_name: 'code_gen',
          active: true,
        },
        {
          id: 'state_2',
          agent_id: 'agent_001',
          timestamp: new Date(Date.now() - 10000).toISOString(),
          goal: 'deploy to prod',
          action: 'attempted deployment',
          outcome: 'failure',
          result: 'Deployment failed: missing env vars',
          tool_name: 'deploy_tool',
          lesson: 'Always check env vars before deployment',
          created_constraint: 'requires ENV_SECRET to be set',
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

    it('should include created constraints', async () => {
      const ctx = await contextWeaver.buildStateContext();

      expect(ctx.operationalState.activeConstraints).toContain('requires ENV_SECRET to be set');
      expect(ctx.systemPrompt).toContain('Active constraints');
    });

    it('should include recent failures with lessons and tool_name', async () => {
      const ctx = await contextWeaver.buildStateContext();

      expect(ctx.operationalState.recentFailures.length).toBe(1);
      expect(ctx.operationalState.recentFailures[0].lesson).toContain('env vars');
      expect(ctx.operationalState.recentFailures[0].tool_name).toBe('deploy_tool');
    });

    it('should format failures with tool_name in system prompt', async () => {
      const ctx = await contextWeaver.buildStateContext();

      // With tool_name, format is: "Failure: deploy_tool returned ..."
      expect(ctx.systemPrompt).toContain('deploy_tool');
    });

    it('should merge local entries with API entries', async () => {
      const localEntry: AgentStateEntry = {
        id: 'local_1',
        agent_id: 'agent_001',
        timestamp: new Date().toISOString(),
        goal: 'local task',
        action: 'local action',
        outcome: 'success',
        result: 'done locally',
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
        outcome: 'success',
        result: 'duplicate',
        active: true,
      };

      const ctx = await contextWeaver.buildStateContext([duplicateEntry]);

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
        outcome: 'success',
        result: 'done offline',
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
        outcome: 'failure',
        result: 'Missing environment variables',
        tool_name: 'deploy_cli',
        lesson: 'Always verify env vars first',
        active: true,
      },
      {
        id: 'state_2',
        agent_id: 'agent_001',
        timestamp: new Date().toISOString(),
        goal: 'deploy to prod',
        action: 'ran deploy command with env vars',
        outcome: 'success',
        result: 'Deployment successful',
        active: true,
      },
    ];

    const trace = reflectionEngine.explainFromState('Why did deployment fail initially?', entries);

    expect(trace.query).toBe('Why did deployment fail initially?');
    expect(trace.steps.length).toBe(2);
    expect(trace.steps[0].thought).toContain('deploy to prod');
    expect(trace.steps[0].thought).toContain('deploy_cli');
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
        outcome: 'failure',
        result: 'Invalid encoding detected',
        lesson: 'Check file encoding before parsing',
        active: true,
      },
    ];

    const trace = reflectionEngine.explainFromState('Why did parsing fail?', entries);

    expect(trace.conclusion).toContain('parse CSV file');
    expect(trace.conclusion).toContain('Check file encoding');
  });
});

// ============================================================================
// ContextWeaver Token Capping Tests
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
    const entries: AgentStateEntry[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push({
        id: `state_${i}`,
        agent_id: 'agent_001',
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        goal: `Goal number ${i}: a fairly long goal description that takes up space in the context`,
        action: `action_${i}`,
        outcome: 'failure',
        result: 'Pending',
        active: true,
      });
    }

    mockApiClient.getAgentState = jest.fn().mockResolvedValue({
      entries,
      total: entries.length,
    });

    const ctx = await contextWeaver.buildStateContext();

    expect(ctx.systemPrompt).toContain('AGENT OPERATIONAL STATE');
    const goalLines = (ctx.systemPrompt.match(/^- Goal number/gm) || []).length;
    expect(goalLines).toBeLessThan(50);
  });

  it('should preserve constraints during trimming', async () => {
    const entries: AgentStateEntry[] = [];

    entries.push({
      id: 'state_d',
      agent_id: 'agent_001',
      timestamp: new Date().toISOString(),
      goal: 'important task',
      action: 'action',
      outcome: 'success',
      result: 'done',
      created_constraint: 'must not call production API',
      active: true,
    });

    for (let i = 0; i < 40; i++) {
      entries.push({
        id: `filler_${i}`,
        agent_id: 'agent_001',
        timestamp: new Date(Date.now() - (i + 1) * 1000).toISOString(),
        goal: `filler goal ${i} with a long description to take up space`,
        action: 'filler action',
        outcome: 'failure',
        result: `Filler failure result for entry ${i}`,
        lesson: `Filler lesson for entry ${i}`,
        active: true,
      });
    }

    mockApiClient.getAgentState = jest.fn().mockResolvedValue({
      entries,
      total: entries.length,
    });

    const ctx = await contextWeaver.buildStateContext();

    expect(ctx.systemPrompt).toContain('must not call production API');
  });
});
