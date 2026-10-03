import { describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { withoutNetwork } from '../src/offline.js';

describe('Принудительный локальный режим', () => {
  it('блокирует fetch, HTTP и TCP, затем восстанавливает процесс', async () => {
    const before = { fetch: globalThis.fetch, request: http.request, connect: net.Socket.prototype.connect };
    await withoutNetwork(async () => {
      await expect(fetch('https://example.test')).rejects.toThrow('mock-режиме');
      expect(() => http.request('http://example.test')).toThrow('mock-режиме');
      const socket = new net.Socket();
      try { expect(() => socket.connect({ host: 'example.test', port: 443 })).toThrow('mock-режиме'); }
      finally { socket.destroy(); }
    });
    expect(globalThis.fetch).toBe(before.fetch);
    expect(http.request).toBe(before.request);
    expect(net.Socket.prototype.connect).toBe(before.connect);
  });
});
