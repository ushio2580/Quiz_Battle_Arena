import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.resolve(process.env.DATABASE_PATH || path.join(root, 'data/qba.sqlite'));
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
for(const migration of fs.readdirSync(path.join(root,'db/migrations')).filter(file=>file.endsWith('.sql')).sort()){
  const version=migration.replace(/\.sql$/,'');
  if(db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version))continue;
  db.exec(fs.readFileSync(path.join(root,'db/migrations',migration),'utf8'));
  db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
}
const template = JSON.parse(fs.readFileSync(path.join(root, 'db/seed-data.json'), 'utf8'));
db.prepare('INSERT OR REPLACE INTO quiz_templates (id,title,description,questions_json) VALUES (?,?,?,?)')
  .run(template.id, template.title, template.description, JSON.stringify(template.questions));
console.log(`Seeded template: ${template.title} (${template.questions.length} questions)`);
db.close();
