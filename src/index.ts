/**
 * RecallBricks Agent Runtime
 *
 * Universal cognitive runtime for AI systems
 * Provides automatic memory, reflection, and identity for any LLM
 */

// Core components
export { AgentRuntime } from './core/AgentRuntime';
export { LLMAdapter } from './core/LLMAdapter';
export { ContextLoader } from './core/ContextLoader';
export { ContextWeaver } from './core/ContextWeaver';
export type { Context, StateContext, ContextWeaverConfig, ContextBuildOptions } from './core/ContextWeaver';
export { AutoSaver } from './core/AutoSaver';
export type { StateExtractionContext } from './core/AutoSaver';
export { IdentityValidator } from './core/IdentityValidator';
export { ReflectionEngine } from './core/ReflectionEngine';
export type {
  Reflection,
  ReflectionType,
  ReflectionTrigger,
  ReasoningTrace,
  ReasoningStep,
} from './core/ReflectionEngine';

// API clients
export { RecallBricksClient } from './api/RecallBricksClient';
export type {
  RecallBricksClientConfig,
  SaveMemoryRequest,
  RecallMemoriesRequest,
  RegisterAgentRequest,
  RegisterAgentResponse,
  RuntimeHeuristics,
} from './api/RecallBricksClient';

// Configuration
export {
  buildConfigFromEnv,
  buildConfigFromOptions,
  createLogger,
  ConfigBuilder,
} from './config';

// Types
export * from './types';
