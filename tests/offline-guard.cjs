// Только тестовый процесс: любой сетевой вызов Node.js падает и попадает в журнал.
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
let attempts = 0;
const events = [];
function deny() {
  attempts++;
  const error = new Error('Network forbidden by offline integration test');
  events.push(error.stack);
  throw error;
}
globalThis.fetch = deny;
for (const name of ['node:http', 'node:https']) {
  const module = require(name); module.request = deny; module.get = deny;
}
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const ipc = typeof first === 'string' ? first.startsWith('/') || first.startsWith('\\\\.\\pipe\\')
    : first && typeof first === 'object' && typeof first.path === 'string' && !('port' in first);
  if (!ipc) return deny();
  return originalConnect.apply(this, args);
};
syncBuiltinESMExports();
process.on('exit', () => fs.writeFileSync(process.env.BENCH_TEST_NETWORK_LOG, JSON.stringify({
  attempts, events, credentialEnvNames: Object.keys(process.env).filter((name) => /(?:API_KEY|SECRET|ACCESS_TOKEN)$/.test(name)),
})));
