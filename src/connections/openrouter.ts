import { z } from 'zod';
import { modeledCost, normalizeOpenRouterUsage, roundUsd } from '../usage.js';
import type { Tariff } from '../schema.js';
import type { ConnectionConfig } from './config.js';
import type { ConnectionRequest, ConnectionResult, Diagnostic, ModelConnection, ReservationBound } from './types.js';
import { emptyResult } from './parsers.js';
import { errorStatus, redact } from './process.js';

const object = z.looseObject({});
const price = z.union([z.string(), z.number()]).transform(Number).pipe(z.number().finite().nonnegative());
const endpointSchema = z.looseObject({ tag: z.string(), provider_name: z.string(), context_length: z.number().int().positive(),
  max_prompt_tokens: z.number().int().positive().nullable().optional(), max_completion_tokens: z.number().int().positive().nullable().optional(),
  pricing: z.looseObject({ prompt: price, completion: price, request: price.optional(), image: price.optional(),
    input_cache_read: price.optional(), input_cache_write: price.optional() }),
});
type Endpoint = z.infer<typeof endpointSchema>;
async function boundedBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8_000_000) { await reader.cancel(); throw new Error('Ответ превышает лимит размера 8 MB'); }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

export class OpenRouterConnection implements ModelConnection {
  private endpoint: Endpoint | null = null;
  private rates: Tariff | null = null;
  private vision = false;
  private tokenizer: string | null = null;
  constructor(readonly config: ConnectionConfig, private readonly baseUrl = 'https://openrouter.ai/api/v1', private readonly fetcher: typeof fetch = globalThis.fetch) {
    const url = new URL(baseUrl);
    if (baseUrl !== 'https://openrouter.ai/api/v1' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Тестовый API допускается только на loopback');
  }
  async diagnose(): Promise<Diagnostic> {
    const diagnostic: Diagnostic = { provider: 'openrouter', status: 'ok', reason: '', version: 'chat-completions-v1',
      authMethod: process.env.OPENROUTER_API_KEY ? 'api-key-env' : null, configuredModel: this.config.model,
      modelAvailability: 'unverified', executionMode: 'model-only', tools: [], config: { providerEndpoint: this.config.providerEndpoint, fallbacks: false } };
    if (!this.config.model || /(?:^openrouter\/auto$|:(?:nitro|floor|online|extended)$)/.test(this.config.model)) {
      return { ...diagnostic, status: 'model_missing', reason: 'Укажите конкретный model ID; маршрутизирующие варианты запрещены' };
    }
    try {
      const path = this.config.model.split('/').map(encodeURIComponent).join('/');
      const response = await this.fetcher(`${this.baseUrl}/models/${path}/endpoints`, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'Cache-Control': 'no-cache' } });
      if (!response.ok) return { ...diagnostic, status: response.status === 404 ? 'model_unavailable' : 'technical_error', reason: `Metadata HTTP ${response.status}` };
      const json = z.looseObject({ data: z.looseObject({ endpoints: z.array(endpointSchema), architecture: object.optional() }) }).parse(JSON.parse(await boundedBody(response)));
      diagnostic.config = { ...diagnostic.config, availableEndpoints: json.data.endpoints.map((e) => ({ tag: e.tag, provider: e.provider_name,
        contextLength: e.context_length, pricing: e.pricing })) };
      if (!this.config.providerEndpoint) return { ...diagnostic, status: 'model_missing', reason: 'Выберите конкретный endpoint tag из availableEndpoints; генерация не выполнялась' };
      const selected = json.data.endpoints.filter((e) => e.tag === this.config.providerEndpoint);
      if (selected.length !== 1) return { ...diagnostic, status: 'model_unavailable', modelAvailability: 'unavailable', reason: 'Endpoint tag отсутствует или неоднозначен; выберите конкретный endpoint' };
      this.endpoint = selected[0]!;
      const outputs = json.data.architecture?.output_modalities;
      if (!Array.isArray(outputs) || !outputs.length || outputs.some(value => value !== 'text')) {
        return { ...diagnostic, status: 'model_unavailable', reason: 'Не подтверждён только текстовый выход; верхняя цена генерации image/audio неизвестна. Платный запуск блокирован' };
      }
      // Не поддерживаем тарифы неизвестных платных инструментов/модальностей.
      for (const [key, value] of Object.entries(this.endpoint.pricing)) if (!['prompt', 'completion', 'request', 'image', 'input_cache_read', 'input_cache_write', 'discount'].includes(key)
        && value !== null && Number(value) !== 0) throw new Error(`Неизвестная верхняя граница тарифа: ${key}`);
      this.rates = { id: `openrouter/${this.config.model}/${this.endpoint.tag}`, version: new Date().toISOString(), asOf: new Date().toISOString().slice(0, 10),
        currency: 'USD', synthetic: false, inputPerMillion: this.endpoint.pricing.prompt * 1e6, outputPerMillion: this.endpoint.pricing.completion * 1e6,
        cacheReadPerMillion: (this.endpoint.pricing.input_cache_read ?? this.endpoint.pricing.prompt) * 1e6,
        cacheWritePerMillion: (this.endpoint.pricing.input_cache_write ?? this.endpoint.pricing.prompt) * 1e6 };
      this.vision = Array.isArray(json.data.architecture?.input_modalities) && json.data.architecture.input_modalities.includes('image');
      this.tokenizer = typeof json.data.architecture?.tokenizer === 'string' ? json.data.architecture.tokenizer : null;
      if (this.config.promptTransport === 'raw-llama3' && (this.tokenizer !== 'Llama3' || !/^meta-llama\/llama-3\.1-(?:8|70|405)b-instruct$/.test(this.config.model))) {
        return { ...diagnostic, status: 'model_unavailable', reason: 'raw-llama3 требует Llama 3.1 instruct и metadata.tokenizer=Llama3; неизвестный tokenizer блокирован' };
      }
      diagnostic.config = { ...diagnostic.config, tariff: this.rates, contextLength: this.endpoint.context_length,
        maxInputTokens: this.endpoint.max_prompt_tokens ?? this.endpoint.context_length, vision: this.vision, pricing: this.endpoint.pricing };
      diagnostic.modelAvailability = 'available';
      if (!process.env.OPENROUTER_API_KEY) return { ...diagnostic, status: 'auth_missing', reason: 'Нет OPENROUTER_API_KEY; metadata доступна, генерация запрещена' };
      return diagnostic;
    } catch (error) { return { ...diagnostic, status: 'technical_error', reason: String(redact(error instanceof Error ? error.message : String(error))) }; }
  }
  tariff(): Tariff | null { return this.rates; }
  async reconcileGeneration(id: string): Promise<{ id: string; costUsd: number | null; terminal: boolean; raw: unknown }> {
    if (!process.env.OPENROUTER_API_KEY || !/^gen-[a-zA-Z0-9-]+$/.test(id)) throw new Error('Для сверки нужны ключ и корректный generation ID');
    const response = await this.fetcher(`${this.baseUrl}/generation?id=${encodeURIComponent(id)}`, { redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Cache-Control': 'no-store' } });
    if (!response.ok) throw new Error(`Сверка OpenRouter HTTP ${response.status}; резерв сохранён`);
    const data = z.looseObject({ data: z.looseObject({ id: z.string(), model: z.string(), total_cost: z.number().finite().nonnegative().nullable(),
      cancelled: z.boolean().optional(), finish_reason: z.string().nullable().optional() }) }).parse(JSON.parse(await boundedBody(response))).data;
    if (data.id !== id || data.model !== this.config.model) throw new Error('Generation относится к другому ID/модели; резерв сохранён');
    const terminal = data.cancelled === true || typeof data.finish_reason === 'string';
    return { id, costUsd: terminal ? data.total_cost : null, terminal, raw: redact(data) };
  }
  private rawPrompt(prompt: string) { return `<|begin_of_text|><|start_header_id|>user<|end_header_id|>\n\n${prompt}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n`; }
  upperBound(maxOutputTokens: number, images: number, request?: Pick<ConnectionRequest, 'prompt' | 'images'>): ReservationBound | null {
    if (!this.rates || !this.endpoint || (images > 0 && !this.vision)) return null;
    if (maxOutputTokens >= this.endpoint.context_length) return null;
    if (this.endpoint.max_completion_tokens && maxOutputTokens > this.endpoint.max_completion_tokens) return null;
    // Для literal raw BPE каждый обычный токен содержит >=1 UTF-8 байта. Спецтокены
    // тоже короче своих строк; +2 покрывает BOS/EOS. Chat/vision сериализует upstream:
    // без опубликованной границы нельзя выдавать эвристику «символы/4» за гарантию.
    // Локальная HTTP-заглушка имеет проверенный literal-протокол. OpenRouter
    // документирует prompt, но не гарантирует отсутствие upstream framing для
    // конкретного endpoint. До такого подтверждения реальные резервы консервативны.
    const raw = this.baseUrl !== 'https://openrouter.ai/api/v1' && this.config.promptTransport === 'raw-llama3' && images === 0 && request && this.tokenizer === 'Llama3';
    const concrete = raw ? Buffer.byteLength(this.rawPrompt(request.prompt)) + 2 : null;
    const context = Math.min(this.endpoint.max_prompt_tokens ?? this.endpoint.context_length, this.endpoint.context_length);
    if (concrete !== null && (concrete > context || concrete + maxOutputTokens > this.endpoint.context_length)) return null;
    const input = concrete === null ? context : Math.min(context, concrete);
    const feesUsd = (this.endpoint.pricing.request ?? 0) + images * (this.endpoint.pricing.image ?? 0);
    const perCallUsd = roundUsd((input * Math.max(this.rates.inputPerMillion, this.rates.cacheReadPerMillion, this.rates.cacheWritePerMillion)
      + maxOutputTokens * this.rates.outputPerMillion) / 1e6 + feesUsd);
    return { perCallUsd, attemptUsd: perCallUsd, inputTokens: input, outputTokens: maxOutputTokens, feesUsd,
      method: concrete === null ? 'endpoint-context' : 'raw-byte-bpe', explanation: concrete === null
        ? 'Неизвестна верхняя граница upstream chat/raw/vision сериализации; резерв по максимальному входу endpoint, включая image tokens. Дополнительно request/image fees и максимальная ставка cache. Семейство tokenizer само по себе не подтверждает framing.'
        : 'Проверенный локальный literal raw Llama3 протокол: UTF-8 байты полного шаблона + 2 BOS/EOS; BPE не создаёт больше токенов, чем байтов. max_tokens включает reasoning. Cache тарифицируется по максимальной ставке.' };
  }
  async execute(request: ConnectionRequest): Promise<ConnectionResult> {
    const result = emptyResult(); result.incurredCostUsd = null; result.usageScope = 'request'; result.agentSteps = 1; result.internalRetries = null;
    if (!this.endpoint || !this.rates || !process.env.OPENROUTER_API_KEY) return { ...result, sent: false, status: 'auth_missing', reason: 'Сначала выполните диагностику и проверьте ключ' };
    if (!this.upperBound(request.maxOutputTokens, request.images.length, request)) return { ...result, sent: false, status: 'model_unavailable', reason: 'Endpoint не поддерживает заданный вход/выход или изображения; нет безопасной границы' };
    const content = request.images.length ? [{ type: 'text', text: request.prompt }, ...request.images.flatMap((i) => [{ type: 'text', text: i.label }, { type: 'image_url', image_url: { url: i.dataUrl } }])] : request.prompt;
    try {
      const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]) : AbortSignal.timeout(request.timeoutMs);
      const response = await this.fetcher(`${this.baseUrl}/chat/completions`, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ model: this.config.model, ...(this.config.promptTransport === 'raw-llama3' && !request.images.length
          ? { prompt: this.rawPrompt(request.prompt), transforms: [], plugins: [{ id: 'context-compression', enabled: false }] } : { messages: [{ role: 'user', content }], transforms: [], plugins: [{ id: 'context-compression', enabled: false }] }), stream: false,
          max_tokens: request.maxOutputTokens, temperature: request.temperature,
          reasoning: request.reasoning === 'none' ? { enabled: false } : { effort: request.reasoning },
          provider: { only: [this.endpoint.tag], order: [this.endpoint.tag], allow_fallbacks: false, require_parameters: true,
            max_price: { prompt: this.rates.inputPerMillion, completion: this.rates.outputPerMillion, request: this.endpoint.pricing.request ?? 0, image: this.endpoint.pricing.image ?? 0 } },
        }) });
      const text = await boundedBody(response);
      let json: Record<string, unknown>;
      try { json = object.parse(JSON.parse(text)); } catch { return { ...result, status: 'invalid_response', reason: 'OpenRouter вернул некорректный JSON', raw: redact(text) }; }
      result.raw = redact(json);
      result.generationId = typeof json.id === 'string' ? json.id : null;
      if (result.generationId) request.onGenerationId?.(result.generationId);
      result.rawUsage = json.usage ? object.parse(redact(json.usage)) : {};
      try { result.usage = normalizeOpenRouterUsage(result.rawUsage); } catch { result.status = 'invalid_response'; result.reason = 'Некорректный usage OpenRouter'; }
      result.incurredCostUsd = result.rawUsage.cost === undefined ? null : z.number().finite().nonnegative().nullable().parse(result.rawUsage.cost);
      const tokensCost = modeledCost(result.usage, this.rates);
      result.estimatedCostUsd = tokensCost === null ? null : roundUsd(tokensCost + (this.endpoint.pricing.request ?? 0) + request.images.length * (this.endpoint.pricing.image ?? 0));
      result.returnedModel = typeof json.model === 'string' ? json.model : null;
      result.returnedProvider = typeof json.provider === 'string' ? json.provider : null;
      if (!response.ok || json.error) {
        result.reason = `HTTP ${response.status}: ${JSON.stringify(redact(json.error ?? json))}`;
        result.status = response.status === 429 || response.status === 402 ? 'quota_exhausted' : errorStatus(result.reason);
        return result;
      }
      const choices = z.array(z.looseObject({ message: z.looseObject({ content: z.string().nullable() }).optional(), text: z.string().optional() })).min(1).parse(json.choices);
      if (!choices[0]?.message && choices[0]?.text === undefined) throw new z.ZodError([]);
      result.output = String(redact(choices[0]!.message?.content ?? choices[0]!.text ?? ''));
      if (result.returnedModel !== this.config.model || result.returnedProvider && ![this.endpoint.provider_name, this.endpoint.tag].includes(result.returnedProvider)) {
        result.status = 'route_changed'; result.reason = 'Фактическая модель/провайдер отличается от закреплённого маршрута';
      }
      return result;
    } catch (error) {
      return { ...result, status: error instanceof Error && /timeout|abort/i.test(error.name + error.message) ? 'timeout'
        : error instanceof z.ZodError ? 'invalid_response' : 'technical_error',
        reason: String(redact(error instanceof Error ? error.message : String(error))) };
    }
  }
}
