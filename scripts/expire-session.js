const db = require('/app/src/db/connection').getDb();
const domain = process.argv[2];
if (!domain) { console.error('Usage: node expire-session.js <domain>'); process.exit(1); }
const route = db.prepare('SELECT id FROM routes WHERE domain = ?').get(domain);
if (!route) { console.error('Route not found:', domain); process.exit(1); }
const result = db.prepare("UPDATE route_auth_sessions SET expires_at = datetime('now', '-1 hour') WHERE route_id = ?").run(route.id);
console.log('Expired', result.changes, 'session(s) for', domain);
