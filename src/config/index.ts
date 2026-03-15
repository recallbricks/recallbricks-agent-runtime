/**
 * RecallBricks Agent Runtime - Configuration System
 *
 * Handles environment variables, validation, and default configuration
 */

import {
  RuntimeConfig,
  RuntimeOptions,
  LLMConfig,
  LLMProvider,
  RecallBricksTier,
  ConfigurationError,
  Logger,
  LogLevel,
} from '../types';

// ============================================================================
// Default Configuration Values
// ============================================================================

const DEFAULT_API_URL = 'https://recallbricks-api-clean.onrender.com';
const DEFAULT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_CONTEXT_TOKENS = 4000;
const DEFAULT_TIER: RecallBricksTier = 'starter';
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 2048;

// Model defaults per provider
const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: 'claude-sonnet-4-5-20250929',
  openai: 'gpt-4-turbo-preview',
  gemini: 'gemini-1.5-pro',
  ollama: 'llama3.2',
  cohere: 'command-r-plus',
  local: 'local-model',
};

// ============================================================================
// Simple Console Logger
// ============================================================================

class ConsoleLogger implements Logger {
  constructor(private level: LogLevel = 'info') {}

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentIndex = levels.indexOf(this.level);
    const messageIndex = levels.indexOf(level);
    return messageIndex >= currentIndex;
  }

  debug(message: string, meta?: unknown): void {
    if (this.shouldLog('debug')) {
      console.error(`[DEBUG] ${message}`, meta || '');
    }
  }

  info(message: string, meta?: unknown): void {
    if (this.shouldLog('info')) {
      console.error(`[INFO] ${message}`, meta || '');
    }
  }

  warn(message: string, meta?: unknown): void {
    if (this.shouldLog('warn')) {
      console.warn(`[WARN] ${message}`, meta || '');
    }
  }

  error(message: string, meta?: unknown): void {
    if (this.shouldLog('error')) {
      console.error(`[ERROR] ${message}`, meta || '');
    }
  }
}

// ============================================================================
// Environment Variable Helpers
// ============================================================================

function getEnv(key: string, defaultValue?: string): string | undefined {
  return process.env[key] || defaultValue;
}

function getEnvRequired(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new ConfigurationError(
      `Required environment variable ${key} is not set`
    );
  }
  return value;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    return defaultValue;
  }
  return parsed;
}

// ============================================================================
// Configuration Builder
// ============================================================================

export class ConfigBuilder {
  private logger: Logger;

  constructor(debug = false) {
    this.logger = new ConsoleLogger(debug ? 'debug' : 'info');
  }

  /**
   * Build configuration from environment variables
   */
  fromEnvironment(): RuntimeConfig {
    this.logger.debug('Building configuration from environment variables');

    const agentId = getEnv('RECALLBRICKS_AGENT_ID');
    const userId = getEnv('RECALLBRICKS_USER_ID');

    if (!agentId || !userId) {
      throw new ConfigurationError(
        'RECALLBRICKS_AGENT_ID and RECALLBRICKS_USER_ID must be set'
      );
    }

    const llmProvider = (getEnv('RECALLBRICKS_LLM_PROVIDER', 'anthropic') ||
      'anthropic') as LLMProvider;
    const llmApiKey = getEnvRequired('RECALLBRICKS_API_KEY');

    const config: RuntimeConfig = {
      agentId,
      userId,
      agentName: getEnv('RECALLBRICKS_AGENT_NAME'),
      agentPurpose: getEnv('RECALLBRICKS_AGENT_PURPOSE'),
      apiUrl: getEnv('RECALLBRICKS_API_URL', DEFAULT_API_URL),
      apiKey: getEnv('RECALLBRICKS_API_KEY', ''),
      llmConfig: this.buildLLMConfig(llmProvider, llmApiKey),
      tier: (getEnv('RECALLBRICKS_TIER', DEFAULT_TIER) ||
        DEFAULT_TIER) as RecallBricksTier,
      autoSave: getEnvBoolean('RECALLBRICKS_AUTO_SAVE', true),
      validateIdentity: getEnvBoolean('RECALLBRICKS_VALIDATE_IDENTITY', true),
      cacheEnabled: getEnvBoolean('RECALLBRICKS_CACHE_ENABLED', true),
      cacheTTL: getEnvNumber('RECALLBRICKS_CACHE_TTL', DEFAULT_CACHE_TTL),
      maxContextTokens: getEnvNumber(
        'RECALLBRICKS_MAX_CONTEXT_TOKENS',
        DEFAULT_MAX_CONTEXT_TOKENS
      ),
      debug: getEnvBoolean('RECALLBRICKS_DEBUG', false),
    };

    this.validateConfig(config);
    this.logger.info('Configuration built successfully', {
      agentId: config.agentId,
      provider: config.llmConfig?.provider,
      tier: config.tier,
    });

    return config;
  }

  /**
   * Build configuration from options object
   */
  fromOptions(options: RuntimeOptions): RuntimeConfig {
    this.logger.debug('Building configuration from options');

    const mcpMode = options.mcpMode || false;
    const llmProvider = options.llmProvider || 'anthropic';
    const llmApiKey = options.llmApiKey;

    // LLM API key is optional in MCP mode
    if (!mcpMode && !llmApiKey) {
      throw new ConfigurationError('LLM API key is required');
    }

    const config: RuntimeConfig = {
      agentId: options.agentId,
      userId: options.userId,
      agentName: options.agentName,
      agentPurpose: options.agentPurpose,
      apiUrl: options.apiUrl || DEFAULT_API_URL,
      apiKey: options.apiKey || getEnv('RECALLBRICKS_API_KEY', ''),
      llmConfig: llmApiKey ? this.buildLLMConfig(llmProvider, llmApiKey, options.llmModel) : undefined,
      tier: options.tier || DEFAULT_TIER,
      autoSave: options.autoSave !== undefined ? options.autoSave : true,
      validateIdentity:
        options.validateIdentity !== undefined
          ? options.validateIdentity
          : true,
      cacheEnabled:
        options.cacheEnabled !== undefined ? options.cacheEnabled : true,
      cacheTTL: options.cacheTTL || DEFAULT_CACHE_TTL,
      maxContextTokens: options.maxContextTokens || DEFAULT_MAX_CONTEXT_TOKENS,
      debug: options.debug || false,
      mcpMode,
      registerAgent: options.registerAgent || false,
      allowedTools: options.allowedTools,
      agentVersion: options.agentVersion,
      captureMode: options.captureMode || 'tools',
    };

    this.validateConfig(config);
    this.logger.info('Configuration built successfully from options');

    return config;
  }

  /**
   * Build LLM configuration
   */
  private buildLLMConfig(
    provider: LLMProvider,
    apiKey: string,
    model?: string
  ): LLMConfig {
    const defaultModel = DEFAULT_MODELS[provider];

    return {
      provider,
      apiKey,
      model: model || getEnv('RECALLBRICKS_LLM_MODEL', defaultModel),
      temperature: getEnvNumber('RECALLBRICKS_LLM_TEMPERATURE', DEFAULT_TEMPERATURE),
      maxTokens: getEnvNumber('RECALLBRICKS_LLM_MAX_TOKENS', DEFAULT_MAX_TOKENS),
      baseUrl: getEnv('RECALLBRICKS_LLM_BASE_URL'),
    };
  }

  /**
   * Validate configuration
   */
  private validateConfig(config: RuntimeConfig): void {
    if (!config.agentId || config.agentId.trim().length === 0) {
      throw new ConfigurationError('Agent ID cannot be empty');
    }

    if (!config.userId || config.userId.trim().length === 0) {
      throw new ConfigurationError('User ID cannot be empty');
    }

    // LLM config validation is skipped in MCP mode
    if (!config.mcpMode && config.llmConfig) {
      if (!config.llmConfig.apiKey || config.llmConfig.apiKey.trim().length === 0) {
        throw new ConfigurationError('LLM API key cannot be empty');
      }

      const validProviders: LLMProvider[] = ['anthropic', 'openai', 'gemini', 'ollama', 'cohere', 'local'];
      if (!validProviders.includes(config.llmConfig.provider)) {
        throw new ConfigurationError(
          `Invalid LLM provider: ${config.llmConfig.provider}. Must be one of: ${validProviders.join(', ')}`
        );
      }
    }

    if (!config.apiUrl || config.apiUrl.trim().length === 0) {
      throw new ConfigurationError('API URL cannot be empty');
    }

    const validTiers: RecallBricksTier[] = ['starter', 'professional', 'enterprise'];
    if (config.tier && !validTiers.includes(config.tier)) {
      throw new ConfigurationError(
        `Invalid tier: ${config.tier}. Must be one of: ${validTiers.join(', ')}`
      );
    }

    if (config.cacheTTL && config.cacheTTL < 0) {
      throw new ConfigurationError('Cache TTL must be non-negative');
    }

    if (config.maxContextTokens && config.maxContextTokens < 100) {
      throw new ConfigurationError('Max context tokens must be at least 100');
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

export function createLogger(debug = false): Logger {
  return new ConsoleLogger(debug ? 'debug' : 'info');
}

export function buildConfigFromEnv(): RuntimeConfig {
  const builder = new ConfigBuilder();
  return builder.fromEnvironment();
}

export function buildConfigFromOptions(options: RuntimeOptions): RuntimeConfig {
  const builder = new ConfigBuilder(options.debug);
  return builder.fromOptions(options);
}
