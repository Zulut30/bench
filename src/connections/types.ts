import type { Usage } from '../usage.js';
import type { Tariff } from '../schema.js';
import type { ConnectionConfig, ProviderId } from './config.js';

export type ConnectionStatus = 'ok' | 'client_missing' | 'auth_missing' | 'auth_incompatible' | 'model_missing'
  | 'model_unavailable' | 'quota_exhausted' | 'timeout' | 'invalid_response' | 'technical_error' | 'limit_exceeded'
  | 'unsupported_client' | 'isolation_unavailable' | 'route_changed' | 'not_evaluated' | 'subscription_policy_unknown';
export interface Diagnostic {
  provider: ProviderId; status: ConnectionStatus; reason: string; version: string | null;
  authMethod: string | null; configuredModel: string | null; modelAvailability: 'available' | 'unverified' | 'unavailable';
  config: Record<string, unknown>; executionMode: 'model-only' | 'agent'; tools: string[];
}
export interface ConnectionRequest {
  prompt: string; workspace: string; taskId: string; attemptIndex: number; timeoutMs: number; maxOutputTokens: number;
  maxAgentTurns: number; temperature: number; reasoning: string;
  images: Array<{ label: string; dataUrl: string }>;
  signal?: AbortSignal;
  onGenerationId?: (id: string) => void;
}
export interface ConnectionResult {
  status: ConnectionStatus; reason: string; output: string | null; raw: unknown;
  rawUsage: Record<string, unknown>; usage: Usage; incurredCostUsd: number | null;
  estimatedCostUsd: number | null; returnedModel: string | null; returnedProvider: string | null;
  generationId: string | null; agentSteps: number | null; internalRetries: number | null;
  usageScope: 'request' | 'session-summary' | 'unknown'; sent: boolean;
}
export interface ModelConnection {
  readonly config: ConnectionConfig;
  diagnose(): Promise<Diagnostic>;
  execute(request: ConnectionRequest): Promise<ConnectionResult>;
  upperBound(maxOutputTokens: number, images: number, request?: Pick<ConnectionRequest, 'prompt' | 'images'>): ReservationBound | null;
  tariff(): Tariff | null;
}
export interface ReservationBound { perCallUsd: number; attemptUsd: number; inputTokens?: number; outputTokens?: number;
  method?: 'raw-byte-bpe' | 'endpoint-context'; explanation?: string; feesUsd?: number; }
