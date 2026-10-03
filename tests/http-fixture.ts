import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

export interface StubRequest { body: Record<string, unknown>; request: IncomingMessage; response: ServerResponse; }
export async function httpFixture(handler: (request: StubRequest, count: number) => void | Promise<void>) {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/endpoints')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: { architecture: { input_modalities: ['text', 'image'] }, endpoints: [{ tag: 'fixture/isolated', provider_name: 'Fixture', context_length: 8192,
        max_prompt_tokens: 8192, max_completion_tokens: 8192, pricing: { prompt: '0.000001', completion: '0.000002', input_cache_read: '0.0000002', input_cache_write: '0.00000125', request: '0', image: '0' } }] } })); return;
    }
    if (request.method !== 'POST' || request.url !== '/api/v1/chat/completions') { response.statusCode = 404; response.end('{}'); return; }
    let text = ''; for await (const chunk of request) text += String(chunk);
    const body = JSON.parse(text) as Record<string, unknown>; bodies.push(body);
    try { await handler({ body, request, response }, bodies.length); } catch { if (!response.writableEnded) { response.statusCode = 500; response.end('{}'); } }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Нет порта HTTP fixture');
  return { baseUrl: `http://127.0.0.1:${address.port}/api/v1`, bodies,
    close: async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); } };
}
export function answer(response: ServerResponse, body: Record<string, unknown>, content: string, overrides: Record<string, unknown> = {}): void {
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: `gen-${randomUUID()}`, model: body.model, provider: 'Fixture',
    choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 10 }, cost: 0.0005 }, ...overrides }));
}
