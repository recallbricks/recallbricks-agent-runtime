/**
 * Tests for AgentRuntime
 */

import { AgentRuntime } from '../src/core/AgentRuntime';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock LLM SDK clients
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Hello, I am TestBot!' }],
        model: 'claude-3-sonnet',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  }));
});

describe('AgentRuntime', () => {
  let mockAxiosInstance: any;

  beforeEach(() => {
    // Create mock axios instance
    mockAxiosInstance = {
      get: jest.fn().mockResolvedValue({
        data: {
          memories: [],
          total: 0,
        },
      }),
      post: jest.fn().mockResolvedValue({
        data: {
          id: 'mem_123',
          text: 'Test memory',
          user_id: 'test_user',
          created_at: new Date().toISOString(),
        },
      }),
      patch: jest.fn().mockResolvedValue({
        data: {},
      }),
      defaults: { headers: {} },
      interceptors: {
        response: {
          use: jest.fn(),
        },
      },
    };

    mockedAxios.create.mockReturnValue(mockAxiosInstance);
    (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(false);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with required options', () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
      });

      expect(runtime).toBeDefined();
      expect(runtime.getConfig().agentId).toBe('test_agent');
      expect(runtime.getConfig().userId).toBe('test_user');
    });

    it('should initialize in MCP mode without LLM key', () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        mcpMode: true,
        apiKey: 'rb_test',
      });

      expect(runtime).toBeDefined();
      expect(runtime.getConfig().mcpMode).toBe(true);
    });

    it('should set default values', () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        debug: true,
      });

      const config = runtime.getConfig();
      expect(config.autoSave).toBe(true);
      expect(config.validateIdentity).toBe(true);
      expect(config.cacheEnabled).toBe(true);
    });
  });

  describe('chat', () => {
    it('should process a chat message and return response', async () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        agentName: 'TestBot',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
        autoSave: false,
      });

      const response = await runtime.chat('Hello!');

      expect(response.response).toBeDefined();
      expect(response.metadata.contextLoaded).toBe(true);
    });

    it('should return context in MCP mode', async () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        agentName: 'TestBot',
        mcpMode: true,
        apiKey: 'rb_test',
        debug: true,
      });

      const response = await runtime.chat('Hello!');

      expect(response.response).toContain('TestBot');
      expect(response.metadata.provider).toBe('none');
      expect(response.metadata.model).toBe('mcp-mode');
    });

    it('should update conversation history', async () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        agentName: 'TestBot',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
        autoSave: false,
      });

      await runtime.chat('First message');
      const history = runtime.getConversationHistory();

      expect(history.length).toBe(2);
      expect(history[0].role).toBe('user');
      expect(history[0].content).toBe('First message');
      expect(history[1].role).toBe('assistant');
    });
  });

  describe('getIdentity', () => {
    it('should return agent identity', () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        agentName: 'TestBot',
        agentPurpose: 'Testing purposes',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
      });

      const identity = runtime.getIdentity();

      expect(identity.id).toBe('test_agent');
      expect(identity.name).toBe('TestBot');
      expect(identity.purpose).toBe('Testing purposes');
    });
  });

  describe('clearConversationHistory', () => {
    it('should clear conversation history', async () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        agentName: 'TestBot',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
        autoSave: false,
      });

      await runtime.chat('Hello');
      expect(runtime.getConversationHistory().length).toBe(2);

      runtime.clearConversationHistory();
      expect(runtime.getConversationHistory().length).toBe(0);
    });
  });

  describe('getVersion', () => {
    it('should return runtime version', () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        debug: true,
      });

      const version = runtime.getVersion();
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe('updateLLMConfig', () => {
    it('should update LLM configuration', () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        debug: true,
      });

      runtime.updateLLMConfig({ temperature: 0.5 });

      const config = runtime.getConfig();
      expect(config.llmConfig?.temperature).toBe(0.5);
    });

    it('should not update in MCP mode', () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        mcpMode: true,
        debug: true,
      });

      runtime.updateLLMConfig({ temperature: 0.5 });

      // Should warn but not crash
      expect(runtime.getConfig().mcpMode).toBe(true);
    });
  });

  describe('getApiClient', () => {
    it('should return the API client', () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
      });

      const apiClient = runtime.getApiClient();
      expect(apiClient).toBeDefined();
    });
  });

  describe('flush', () => {
    it('should flush pending saves', async () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
      });

      await runtime.flush();
      // Should complete without error
    });
  });

  describe('shutdown', () => {
    it('should shutdown gracefully', async () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
      });

      await runtime.shutdown();
      // Should complete without error
    });
  });

  describe('recovery on block', () => {
    it('should call LLM with recovery prompt when constraint blocks', async () => {
      // Mock checkConstraints to return blocked on first POST to /check
      let postCallCount = 0;
      mockAxiosInstance.post.mockImplementation((url: string, _data: any) => {
        postCallCount++;
        if (url.includes('/constraints/') && url.includes('/check')) {
          return Promise.resolve({
            data: {
              allowed: false,
              violations: [{
                constraint_id: 'c1',
                constraint_text: 'Never call production API',
                decision: 'blocked',
                mode: 'enforce',
              }],
            },
          });
        }
        // Default: memory/state saves
        return Promise.resolve({
          data: { id: 'mem_' + postCallCount, text: 'ok', created_at: new Date().toISOString() },
        });
      });

      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        agentName: 'TestBot',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
        autoSave: false,
      });

      const response = await runtime.chat('Call the production API');

      // Should have called the LLM for recovery (response comes from mocked Anthropic)
      expect(response.response).toBeDefined();
      expect(response.metadata.recoveredFromBlock).toBe(true);
      expect(response.metadata.constraintViolations).toBeDefined();
      expect(response.metadata.constraintViolations!.length).toBe(1);
      expect(response.metadata.constraintViolations![0].constraint_text).toBe('Never call production API');
    });

    it('should return blocked response in MCP mode when no LLM available', async () => {
      mockAxiosInstance.post.mockImplementation((url: string) => {
        if (url.includes('/constraints/') && url.includes('/check')) {
          return Promise.resolve({
            data: {
              allowed: false,
              violations: [{
                constraint_id: 'c1',
                constraint_text: 'No deletions allowed',
                decision: 'blocked',
                mode: 'enforce',
              }],
            },
          });
        }
        return Promise.resolve({
          data: { id: 'mem_1', text: 'ok', created_at: new Date().toISOString() },
        });
      });

      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        agentName: 'TestBot',
        mcpMode: true,
        apiKey: 'rb_test',
        debug: true,
      });

      const response = await runtime.chat('Delete everything');

      expect(response.response).toContain('No deletions allowed');
      expect(response.metadata.provider).toBe('none');
      expect(response.metadata.constraintViolations).toBeDefined();
      expect(response.metadata.recoveredFromBlock).toBeUndefined();
    });
  });

  describe('reportFailure', () => {
    it('should create a failure state entry with failure_signature', async () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
        agentVersion: '2.0.0',
      });

      const entry = await runtime.reportFailure({
        goal: 'charge customer',
        action: 'stripe.charges.create',
        tool_name: 'stripe',
        error_code: '429',
        result: 'rate limited',
        lesson: 'use batch endpoint for bulk charges',
      });

      expect(entry.outcome).toBe('failure');
      expect(entry.tool_name).toBe('stripe');
      expect(entry.error_code).toBe('429');
      expect(entry.failure_signature).toBeTruthy();
      expect(entry.failure_signature).toContain('stripe');
      expect(entry.failure_signature).toContain('429');
      expect(entry.source).toBe('explicit');
      expect(entry.agent_version).toBe('2.0.0');
    });

    it('should auto-create constraint when createConstraint is provided', async () => {
      mockAxiosInstance.post.mockImplementation((url: string) => {
        if (url === '/api/v1/constraints') {
          return Promise.resolve({
            data: {
              id: 'c_auto',
              agent_id: 'test_agent',
              constraint_text: 'Do not call stripe.charges.create in bulk',
              mode: 'observe',
              active: true,
            },
          });
        }
        return Promise.resolve({
          data: { id: 'state_1', created_at: new Date().toISOString() },
        });
      });

      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
      });

      const entry = await runtime.reportFailure({
        goal: 'charge customer',
        action: 'stripe.charges.create',
        createConstraint: 'Do not call stripe.charges.create in bulk',
      });

      expect(entry.created_constraint).toBe('c_auto');
    });
  });

  describe('reportSuccess', () => {
    it('should create a success entry and supersede prior failures', async () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
        autoSave: false,
      });

      // First report a failure
      const failEntry = await runtime.reportFailure({
        goal: 'deploy app',
        action: 'deploy_tool run',
        result: 'timeout',
      });
      expect(failEntry.active).toBe(true);

      // Then report success for the same goal
      const successEntry = await runtime.reportSuccess({
        goal: 'deploy app',
        action: 'deploy_tool run',
        result: 'deployed successfully',
      });

      expect(successEntry.outcome).toBe('success');
      expect(successEntry.source).toBe('explicit');
      // The prior failure should be superseded (checked via getActiveStateEntries)
    });
  });

  describe('checkBeforeExecute', () => {
    it('should block tool not in allowedTools', async () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
        allowedTools: ['read_file', 'write_file'],
      });

      const result = await runtime.checkBeforeExecute('delete_database');

      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBe(1);
      expect(result.violations[0].constraint_text).toContain('delete_database');
    });

    it('should allow tool in allowedTools (case-insensitive) and call API', async () => {
      mockAxiosInstance.post.mockImplementation((url: string) => {
        if (url.includes('/constraints/') && url.includes('/check')) {
          return Promise.resolve({
            data: { allowed: true, violations: [] },
          });
        }
        return Promise.resolve({
          data: { id: 'mem_1', text: 'ok', created_at: new Date().toISOString() },
        });
      });

      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
        allowedTools: ['Read_File', 'Write_File'],
      });

      const result = await runtime.checkBeforeExecute('read_file');

      expect(result.allowed).toBe(true);
    });
  });

  describe('config options', () => {
    it('should pass allowedTools, agentVersion, captureMode through config', () => {
      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
        allowedTools: ['tool_a', 'tool_b'],
        agentVersion: '2.0.0',
        captureMode: 'tools',
      });

      const config = runtime.getConfig();
      expect(config.allowedTools).toEqual(['tool_a', 'tool_b']);
      expect(config.agentVersion).toBe('2.0.0');
      expect(config.captureMode).toBe('tools');
    });
  });

  describe('constraint convenience methods', () => {
    it('getConstraints should return constraints from API', async () => {
      mockAxiosInstance.get.mockImplementation((url: string) => {
        if (url.includes('/constraints/')) {
          return Promise.resolve({
            data: {
              constraints: [
                { id: 'c1', agent_id: 'test_agent', constraint_text: 'no prod', mode: 'enforce', active: true },
              ],
            },
          });
        }
        return Promise.resolve({ data: { memories: [], total: 0 } });
      });

      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
      });

      const constraints = await runtime.getConstraints();
      expect(constraints.length).toBe(1);
      expect(constraints[0].constraint_text).toBe('no prod');
    });

    it('promoteConstraint should call updateConstraint with enforce mode', async () => {
      mockAxiosInstance.patch.mockResolvedValueOnce({
        data: { id: 'c1', mode: 'enforce', constraint_text: 'no prod', active: true },
      });

      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
      });

      const result = await runtime.promoteConstraint('c1');
      expect(result.mode).toBe('enforce');
      expect(mockAxiosInstance.patch).toHaveBeenCalledWith(
        '/api/v1/constraints/c1',
        { mode: 'enforce' }
      );
    });

    it('getEnforcementLog should merge local and API entries', async () => {
      mockAxiosInstance.get.mockImplementation((url: string) => {
        if (url.includes('/enforcement/')) {
          return Promise.resolve({
            data: {
              entries: [{
                id: 'el1',
                agent_id: 'test_agent',
                constraint_id: 'c1',
                proposed_action: 'delete db',
                decision: 'blocked',
                constraint_text: 'no deletions',
                created_at: '2026-01-01T00:00:00Z',
              }],
            },
          });
        }
        return Promise.resolve({ data: { memories: [], total: 0 } });
      });

      // First trigger a local enforcement entry via blocked constraint
      mockAxiosInstance.post.mockImplementation((url: string) => {
        if (url.includes('/constraints/') && url.includes('/check')) {
          return Promise.resolve({
            data: {
              allowed: false,
              violations: [{
                constraint_id: 'c2',
                constraint_text: 'no exec',
                decision: 'blocked',
                mode: 'enforce',
              }],
            },
          });
        }
        return Promise.resolve({
          data: { id: 'mem_1', text: 'ok', created_at: new Date().toISOString() },
        });
      });

      const runtime = new AgentRuntime({
        agentId: 'test_agent',
        userId: 'test_user',
        agentName: 'TestBot',
        llmProvider: 'anthropic',
        llmApiKey: 'test_key',
        apiKey: 'rb_test',
        debug: true,
        autoSave: false,
      });

      // Trigger a blocked action to create a local enforcement entry
      await runtime.chat('exec dangerous command');

      const log = await runtime.getEnforcementLog();

      // Should have both local (from chat) and API entries
      expect(log.length).toBe(2);
      // Local entry
      expect(log[0].action).toContain('exec dangerous command');
      // API entry
      expect(log[1].action).toBe('delete db');
      expect(log[1].timestamp).toBe('2026-01-01T00:00:00Z');
    });
  });
});
