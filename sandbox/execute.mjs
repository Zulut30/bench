// Только публичный протокол запуска, без условий и эталонов скрытых проверок.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const kind = process.argv[2], data = JSON.parse(readFileSync(0, 'utf8') || '{}');
if (kind === 'sql') {
  const db = new DatabaseSync(':memory:'); db.exec(data.schema);
  console.log(JSON.stringify(db.prepare(readFileSync('query.sql', 'utf8')).all())); db.close();
} else {
  const m = await import('file://' + process.cwd() + '/solution.ts');
  let out;
  if (kind === 'test-writing') { const fn = (0, eval)('(' + data.function + ')'); try { await m.verify(fn); out = { detected: false }; } catch { out = { detected: true }; } }
  else if (kind === 'security') { const db = new DatabaseSync(':memory:'); db.exec(data.schema); out = data.inputs.map(x => m.lookupUser(db, x)); db.close(); }
  else if (kind === 'probe') out = await m.probe();
  else {
    let mutated = false;
    const values = await Promise.all(data.inputs.map(async x => { const before = JSON.stringify(x), value = await m[data.exportName](x); mutated ||= before !== JSON.stringify(x); return value; }));
    out = { values, mutated };
  }
  console.log(JSON.stringify(out));
}
