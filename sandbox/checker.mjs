import { readFileSync, writeFileSync, mkdirSync, chmodSync, chownSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from '/opt/deps/node_modules/playwright/index.mjs';
const input = JSON.parse(readFileSync(0, 'utf8')), uid = 10001, cwd = '/candidate/work';
const contracts = { frontend: ['index.html','app.ts','styles.css'], 'ui-design': ['index.html','styles.css'], backend: ['server.ts'], devops: ['Dockerfile','server.ts','start.sh'], sql: ['query.sql'], algorithms: ['solution.ts'], debugging: ['solution.ts'], refactoring: ['solution.ts'], security: ['solution.ts'], 'test-writing': ['solution.ts'], probe: ['solution.ts'] };
const allowed = contracts[input.kind], paths = input.files?.map(f => f.path);
if (!allowed || !Array.isArray(input.files) || new Set(paths).size !== allowed.length || paths.length !== allowed.length || input.files.some(f => !allowed.includes(f.path) || typeof f.content !== 'string' || Buffer.byteLength(f.content) > 256000 || f.content.includes('\0')) || input.files.reduce((sum,f) => sum + Buffer.byteLength(f.content),0) > 512000) throw Error('Недопустимый контракт файлов контейнера');
setTimeout(() => process.exit(124), Math.min(input.timeoutMs ?? 30000, 60000)).unref();
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: cwd, LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1', PORT: '3000' };
mkdirSync(cwd, { recursive: true }); chmodSync('/candidate', 0o711); chmodSync(cwd, 0o700); chownSync(cwd, uid, uid);
for (const f of input.files) { const path = join(cwd, f.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, f.content); chownSync(path, uid, uid); }
let logs = [], results = [], screenshots = [], browserVersion = null;
const defaultFont = spawnSync('/usr/bin/fc-match', ['-f', '%{family}|%{file}', 'Arial'], { encoding: 'utf8', env }).stdout.trim();
const check = (id, pass, reason, score = pass ? 1 : 0) => results.push({ id, pass, score, reason });
function command(args, data, timeout = 8000) {
  return new Promise(resolve => {
    const p = spawn('/usr/local/bin/node', args, { cwd, env, uid, gid: uid, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', size = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeout);
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', b => { size += Buffer.byteLength(b); if (size > 1000000) p.kill('SIGKILL'); else output += b; });
    p.stderr.on('data', b => { if (errors.length < 32000) errors += b; });
    p.stdin.on('error', () => {}); p.on('error', e => { errors += e.message; });
    p.on('close', code => { clearTimeout(timer); logs.push({ args, code, timedOut, stderr: errors, output: output.slice(0, 32000) }); resolve({ code, output, timedOut }); }); p.stdin.end(data === undefined ? '' : JSON.stringify(data));
  });
}
async function build(files) {
  const ts = files.filter(f => f.path.endsWith('.ts')).map(f => f.path);
  if (!ts.length) return true;
  const r = await command(['/opt/deps/node_modules/typescript/lib/tsc.js', '--noEmit', '--target', 'es2023', '--module', 'nodenext', '--strict', '--skipLibCheck', '--types', 'node', '--typeRoots', '/opt/deps/node_modules/@types', ...ts], undefined, 12000);
  check('build', r.code === 0, r.code === 0 ? 'TypeScript strict: сборка пройдена' : 'TypeScript strict: ошибка сборки'); return r.code === 0;
}
function parse(result) { if (result.code !== 0) return null; try { return JSON.parse(result.output); } catch { return null; } }
async function api(kind) {
  const isDevops = kind === 'devops';
  const child = spawn(isDevops ? '/bin/sh' : '/usr/local/bin/node', isDevops ? ['./start.sh'] : ['server.ts'], { cwd, env, uid, gid: uid, stdio: ['ignore', 'pipe', 'pipe'] });
  let code = null, size = 0; child.on('error', () => {}); child.on('exit', n => { code = n; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { size += b.length; if (size > 64000) child.kill('SIGKILL'); });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(80) }); break; } catch { if (code !== null) break; await new Promise(r => setTimeout(r, 30)); } }
    const request = async (url, init) => { const r = await fetch('http://127.0.0.1:3000' + url, { ...init, signal: AbortSignal.timeout(1000) }); return { status: r.status, body: await r.json() }; };
    const h = await request('/health'); check('health', h.status === 200 && h.body.status === 'ok', 'GET /health → 200 {status:ok}');
    if (isDevops) {
      const d = readFileSync(join(cwd, 'Dockerfile'), 'utf8');
      check('docker-contract', /^FROM node:24\.16\.0-bookworm-slim(?:@sha256:[a-f0-9]{64})?\s*$/m.test(d) && /^USER (?:node|1000|10001)\s*$/m.test(d) && /ENTRYPOINT\s+\["\/bin\/sh",\s*"\.\/start\.sh"\]/.test(d) && !/^(?:ADD|RUN)\b/m.test(d), 'Закреплён Node, non-root и exec entrypoint; без сетевой установки');
    } else {
      const normal = await request('/items?page=2&limit=2');
      check('pagination', normal.status === 200 && isDeepStrictEqual(normal.body, { items: [{ id: 3, name: 'C' }, { id: 4, name: 'D' }], total: 5, page: 2, limit: 2 }), 'Реальный HTTP: page=2, limit=2, total=5');
      const empty = await request('/items?page=5&limit=2'); check('empty-page', empty.status === 200 && isDeepStrictEqual(empty.body.items, []), 'Страница за концом данных пуста');
      for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=x', 'limit=0', 'limit=101', 'limit=2x']) { const bad = await request('/items?' + query); check('invalid-' + query, bad.status === 400 && typeof bad.body.error === 'string', 'Некорректный ' + query + ' → JSON 400'); }
      const missing = await request('/unknown'); check('not-found', missing.status === 404 && typeof missing.body.error === 'string', 'Неизвестный путь → JSON 404');
      const method = await request('/items', { method: 'POST' }); check('method', method.status === 405, 'POST /items → 405');
    }
  } catch (e) { check('api', false, 'Не работает HTTP API: ' + e.message); }
  finally { child.kill('SIGKILL'); }
}
async function frontend(kind) {
  const pub = join(cwd, 'public'); mkdirSync(pub, { recursive: true }); chownSync(pub, uid, uid);
  for (const f of input.files.filter(f => !f.path.endsWith('.ts'))) writeFileSync(join(pub, f.path), readFileSync(join(cwd, f.path)));
  if (input.files.some(f => f.path === 'app.ts')) {
    const buildResult = await command(['/opt/deps/node_modules/typescript/lib/tsc.js', '--target', 'es2022', '--module', 'esnext', '--strict', '--lib', 'dom,es2022', '--skipLibCheck', '--typeRoots', '/opt/deps/node_modules/@types', '--outDir', 'public', 'app.ts']);
    check('browser-build', buildResult.code === 0, 'Сборка браузерного TypeScript'); if (buildResult.code !== 0) return;
  }
  const server = createServer((req, res) => { const name = req.url === '/' ? 'index.html' : req.url?.slice(1); if (!['index.html', 'app.js', 'styles.css'].includes(name)) { res.writeHead(404).end(); return; } try { res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html'); res.end(readFileSync(join(pub, name))); } catch { res.writeHead(404).end(); } });
  await new Promise(r => server.listen(3210, '127.0.0.1', r)); const browser = await chromium.launch({ headless: true });
  browserVersion = browser.version();
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, javaScriptEnabled: true, serviceWorkers: 'block', locale: 'ru-RU', deviceScaleFactor: 1 });
      await context.route('**/*', route => { const u = new URL(route.request().url()); return u.hostname === '127.0.0.1' && u.port === '3210' ? route.continue() : route.abort(); });
      const page = await context.newPage(); await page.goto('http://127.0.0.1:3210/');
      check('responsive-' + width, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Нет горизонтального скролла при ' + width + 'px');
      if (kind === 'frontend') {
        const email = page.getByLabel('Email', { exact: true }), submit = page.getByRole('button', { name: 'Подписаться', exact: true }), status = page.getByRole('status');
        await email.fill(''); await submit.click(); check('empty-' + width, (await status.innerText()).includes('Введите email'), 'Пустой email: доступная ошибка');
        await email.fill('broken'); await submit.click(); check('invalid-' + width, (await status.innerText()).includes('Некорректный email'), 'Невалидный email: ошибка');
        // Точка в домене не оговорена заданием и не обязательна для HTML type=email.
        for (const invalid of ['@example.org', 'user@@example.org', 'user name@example.org']) {
          await email.fill(invalid); await submit.click(); check('invalid-email-' + invalid + '-' + width, (await status.innerText()).includes('Некорректный email'), 'Отвергнут некорректный адрес: ' + invalid);
        }
        await email.fill('user@example.org'); await submit.click(); check('submit-' + width, (await status.innerText()).includes('Спасибо') && await email.inputValue() === '', 'Успешная подписка и очистка поля');
        await email.fill('other@example.org'); await submit.click(); check('repeat-' + width, (await status.innerText()).includes('Спасибо'), 'Повторное взаимодействие работает');
      } else {
        const text = await page.locator('body').innerText();
        check('design-content-' + width, ['Старт', 'Команда', 'Бизнес'].every(x => text.includes(x))
          && [/(?<!\d)0\s*₽/, /(?<!\d)990\s*₽/, /(?<!\d)2990\s*₽/].every(pattern => pattern.test(text))
          && (await page.getByRole('button').count() + await page.getByRole('link').count()) >= 3, 'Три тарифа из брифа и CTA (кнопки/ссылки)');
      }
      screenshots.push({ width, data: (await page.screenshot({ fullPage: true, animations: 'disabled' })).toString('base64') }); await context.close();
    }
  } catch (e) { check('browser', false, e.message); } finally { await browser.close(); server.close(); }
}
try {
  if (await build(input.files)) {
    const k = input.kind;
    if (['backend', 'devops'].includes(k)) await api(k);
    else if (['frontend', 'ui-design'].includes(k)) await frontend(k);
    else if (k === 'sql') {
      const schema = "CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT);CREATE TABLE orders(id INTEGER PRIMARY KEY,customer_id INTEGER,amount INTEGER,status TEXT);INSERT INTO customers VALUES(1,'Анна'),(2,'Борис'),(3,'Вера');INSERT INTO orders VALUES(1,1,100,'paid'),(2,1,50,'pending'),(3,2,0,'paid'),(4,1,200,'paid');";
      const rows = parse(await command(['/opt/deps/execute.mjs', k], { schema }));
      check('rows', isDeepStrictEqual(rows, [{ customer_id: 1, name: 'Анна', paid_total: 300 }, { customer_id: 2, name: 'Борис', paid_total: 0 }, { customer_id: 3, name: 'Вера', paid_total: 0 }]), 'SQLite: LEFT JOIN, только paid, нулевые суммы, порядок');
    } else if (k === 'test-writing') {
      const functions = ["w=>{if(!Number.isFinite(w)||w<0)throw Error('weight');return w===0?0:w<=1?5:w<=5?10:20}", "w=>w===0?0:w<1?5:w<=5?10:20", "w=>w===0?0:w<=1?5:w<5?10:20", "w=>w<=1?5:w<=5?10:20", "w=>w===0?0:w<=1?5:w<=5?10:20"];
      const outcomes = []; for (const fn of functions) outcomes.push(parse(await command(['/opt/deps/execute.mjs', k], { function: fn })));
      check('accept-correct', outcomes[0]?.detected === false, 'Тесты принимают исправный shipping');
      const killed = outcomes.slice(1).filter(x => x?.detected === true).length;
      check('mutation-detection', killed === 4, 'Обнаружено дефектов: ' + killed + '/4 (границы 1/5, ноль, отрицательное значение)', killed / 4);
    } else if (k === 'security') {
      const schema = "CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT);INSERT INTO users VALUES(1,'alice@example.org'),(2,'bob@example.org');";
      const out = parse(await command(['/opt/deps/execute.mjs', k], { schema, inputs: ['alice@example.org', "x' OR 1=1 --", 'missing@example.org'] }));
      check('sql-injection', isDeepStrictEqual(out, [{ id: 1, email: 'alice@example.org' }, null, null]), 'Параметризованный поиск и отсутствие утечки при SQL injection');
    } else if (k === 'probe') {
      const out = parse(await command(['/opt/deps/execute.mjs', k], {})); check('probe', out !== null, 'Проверка изоляции'); logs.push({ probe: out });
    } else {
      const cases = k === 'algorithms' ? { exportName: 'mergeRanges', inputs: [[], [{ start: 3, end: 4 }, { start: 1, end: 3 }], [{ start: -3, end: -1 }, { start: 0, end: 0 }], [{ start: 1, end: 5 }, { start: 2, end: 3 }]], expected: [[], [{ start: 1, end: 4 }], [{ start: -3, end: -1 }, { start: 0, end: 0 }], [{ start: 1, end: 5 }]] }
      : k === 'debugging' ? { exportName: 'summarize', inputs: [[], [{ group: 'a', cents: 10 }, { group: 'a', cents: 20 }, { group: 'b', cents: 0 }], [{ group: '__proto__', cents: 5 }, { group: 'constructor', cents: -3 }]], expected: [{}, { a: 30, b: 0 }, { '__proto__': 5, constructor: -3 }] }
      : { exportName: 'invoiceTotal', inputs: [{ items: [], discount: 0, tax: 0 }, { items: [{ cents: 105, count: 2 }], discount: 10, tax: 20 }, { items: [{ cents: 1, count: 1 }], discount: 0, tax: 50 }, { items: [{ cents: 999, count: 3 }], discount: 100, tax: 20 }], expected: [0, 227, 2, 0] };
      if (k === 'debugging') cases.expected[2] = JSON.parse('{"__proto__":5,"constructor":-3}');
      const out = parse(await command(['/opt/deps/execute.mjs', k], { exportName: cases.exportName, inputs: cases.inputs }));
      for (let i = 0; i < cases.inputs.length; i++) check('case-' + i, out !== null && isDeepStrictEqual(out.values?.[i], cases.expected[i]), 'Функциональный пример ' + (i + 1) + ', включая границы');
      if (k === 'algorithms') check('immutable-input', out?.mutated === false, 'Исходные диапазоны не меняются');
    }
  }
} catch (e) { check('execution', false, String(e)); }
console.log(JSON.stringify({ results, logs, screenshots, environment: { node: process.version, browser: chromium.name(), browserVersion, defaultFont, locale: 'ru-RU', deviceScaleFactor: 1, imageContract: 'bench-sandbox-v1', candidateUid: uid, network: 'none' } }));
