import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

// promptfoo 0.123.1 посылает opt-out event даже с DISABLE_TELEMETRY.
// Mock не нуждается во внешнем I/O; локальный IPC tsx/Playwright остаётся доступен.
export async function withoutNetwork<T>(action: () => Promise<T>): Promise<T> {
  const original = { fetch: globalThis.fetch, httpRequest: http.request, httpGet: http.get,
    httpsRequest: https.request, httpsGet: https.get, connect: net.Socket.prototype.connect };
  const denied = () => { throw new Error('Внешние запросы запрещены в mock-режиме'); };
  globalThis.fetch = async () => denied();
  http.request = denied; http.get = denied; https.request = denied; https.get = denied;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: Parameters<typeof net.Socket.prototype.connect>) {
    const first = (Array.isArray(args[0]) ? args[0][0] : args[0]) as unknown;
    const localIpc = typeof first === 'string' ? first.startsWith('/') || first.startsWith('\\\\.\\pipe\\')
      : typeof first === 'object' && first !== null && 'path' in first && typeof first.path === 'string' && !('port' in first);
    if (!localIpc) return denied();
    return original.connect.apply(this, args);
  } as typeof net.Socket.prototype.connect;
  syncBuiltinESMExports();
  try { return await action(); } finally {
    globalThis.fetch = original.fetch; http.request = original.httpRequest; http.get = original.httpGet;
    https.request = original.httpsRequest; https.get = original.httpsGet; net.Socket.prototype.connect = original.connect;
    syncBuiltinESMExports();
  }
}

// В реальном режиме движок может обращаться только к явно выбранному публичному API.
export async function withApiNetwork<T>(baseUrl: string, action: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${baseUrl}/`)) return Promise.reject(new Error('Внешний запрос вне выбранного API запрещён'));
    return original(input, init);
  };
  try { return await action(); } finally { globalThis.fetch = original; }
}
