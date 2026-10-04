import { join } from 'node:path';
import { readJson } from '../storage.js';
import { mockUsage, responsesSchema } from '../mock-provider.js';
import { normalizeMockUsage } from '../usage.js';
import { projectRoot, loadInputs } from '../runner.js';
import { billingMode } from './config.js';
import type { ConnectionConfig } from './config.js';
import type { ConnectionRequest, ConnectionResult, ModelConnection } from './types.js';
import { CliConnection } from './cli.js';
import { OpenRouterConnection } from './openrouter.js';
import { emptyResult } from './parsers.js';
import { ManualConnection } from '../manual.js';

export class MockConnection implements ModelConnection {
  constructor(readonly config: ConnectionConfig) {}
  async diagnose() { return { provider: this.config.provider, status: 'ok' as const, reason: 'Только synthetic fixtures', version: 'fixture-1',
    authMethod: null, configuredModel: 'mock-practical-v1', modelAvailability: 'available' as const,
    config: { synthetic: true }, executionMode: 'model-only' as const, tools: [] }; }
  tariff() { return loadInputs().config.tariff; }
  upperBound() { return { perCallUsd: 0, attemptUsd: 0 }; }
  async execute(request: ConnectionRequest): Promise<ConnectionResult> {
    if (request.taskId.startsWith('v1-')) {
      const fixture = (readJson(join(projectRoot, 'fixtures/standard-examples.json')) as Record<string, { correctAlternatives: string[] }>)[request.taskId];
      if (!fixture) return { ...emptyResult(), sent: false, status: 'model_unavailable', reason: 'Нет standard fixture' };
      const rawUsage = { inputTokens: Buffer.byteLength(request.prompt), outputTokens: 512, reasoningTokens: 32, cacheReadTokens: 0, cacheWriteTokens: 0 };
      return { ...emptyResult(), output: fixture.correctAlternatives[(request.attemptIndex - 1) % fixture.correctAlternatives.length]!,
        raw: { synthetic: true, fixtureVersion: 'standard-validation-1' }, rawUsage, usage: normalizeMockUsage(rawUsage),
        returnedModel: 'mock-practical-v1', returnedProvider: 'local-mock', agentSteps: 1, internalRetries: 0, usageScope: 'request' };
    }
    const response = responsesSchema.parse(readJson(join(projectRoot, 'fixtures/mock-responses.json')))[request.taskId];
    if (!response) return { ...emptyResult(), status: 'model_unavailable', reason: 'Нет демонстрационной fixture', sent: false };
    const rawUsage = mockUsage(request.taskId, 1).raw;
    return { ...emptyResult(), output: response.correct, raw: { synthetic: true }, rawUsage, usage: normalizeMockUsage(rawUsage),
      returnedModel: 'mock-practical-v1', returnedProvider: 'local-mock', agentSteps: 1, internalRetries: 0, usageScope: 'request' };
  }
}
export function createConnection(config: ConnectionConfig, protectedPaths: string[], testOptions: { apiBaseUrl?: string } = {}): ModelConnection {
  if (config.provider === 'openrouter') return new OpenRouterConnection(config, testOptions.apiBaseUrl);
  if (billingMode(config.provider) === 'subscription') return new CliConnection(config, protectedPaths);
  if (config.provider === 'mock') return new MockConnection(config);
  return new ManualConnection(config, { version: 1, model: config.model ?? 'manual', clientVersion: 'webchat-unverified', executionMode: config.executionMode, answers: [] });
}
