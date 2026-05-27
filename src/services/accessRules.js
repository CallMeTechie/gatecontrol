'use strict';
const { getDb } = require('../db/connection');
const { parseMaintenanceActive } = require('./rdpMaintenance');

function _dateActive(rule, now) {
  if (rule.valid_from) { const [y,m,d]=rule.valid_from.split('-').map(Number); if (now < new Date(y,m-1,d,0,0,0,0)) return false; }
  if (rule.valid_until) { const [y,m,d]=rule.valid_until.split('-').map(Number); if (now > new Date(y,m-1,d,23,59,59,999)) return false; }
  return true;
}
function rulesFor(targetType, targetId) {
  return getDb().prepare('SELECT * FROM access_rules WHERE target_type=? AND target_id=? AND enabled=1').all(targetType, targetId);
}
/** PURE: DB rows + clock only. */
function evaluate(targetType, targetId, now = new Date()) {
  const applicable = rulesFor(targetType, targetId).filter(r => _dateActive(r, now));
  const blocks = applicable.filter(r => r.mode === 'block');
  const allows = applicable.filter(r => r.mode === 'allow');
  for (const b of blocks) if (parseMaintenanceActive(b.schedule, now)) return { state:'denied', reason:{ rule:b } };
  if (allows.length > 0) {
    const hit = allows.find(a => parseMaintenanceActive(a.schedule, now));
    return hit ? { state:'allowed', reason:{ rule:hit } } : { state:'denied', reason:{ noAllowMatch:true } };
  }
  return { state:'allowed', reason:{ default:true } };
}
function isDenied(targetType, targetId, now = new Date()) { return evaluate(targetType, targetId, now).state === 'denied'; }
function anyRulesExist() { return !!getDb().prepare('SELECT 1 FROM access_rules LIMIT 1').get(); }
function listRules(targetType, targetId) {
  return getDb().prepare('SELECT * FROM access_rules WHERE target_type=? AND target_id=? ORDER BY id').all(targetType, targetId);
}
function createRule({ target_type, target_id, mode, schedule, valid_from, valid_until, label }) {
  const info = getDb().prepare(`INSERT INTO access_rules (target_type,target_id,mode,schedule,valid_from,valid_until,label) VALUES (?,?,?,?,?,?,?)`)
    .run(target_type, target_id, mode, schedule, valid_from||null, valid_until||null, label||null);
  return { id: Number(info.lastInsertRowid) };
}
function updateRule(id, fields) {
  const cols=[],vals=[]; for (const k of ['mode','schedule','valid_from','valid_until','label','enabled']) if (k in fields) { cols.push(`${k}=?`); vals.push(fields[k]); }
  if (!cols.length) return; cols.push("updated_at=datetime('now')"); vals.push(id);
  getDb().prepare(`UPDATE access_rules SET ${cols.join(',')} WHERE id=?`).run(...vals);
}
function deleteRule(id) { getDb().prepare('DELETE FROM access_rules WHERE id=?').run(id); }
function deleteForTarget(targetType, targetId) { getDb().prepare('DELETE FROM access_rules WHERE target_type=? AND target_id=?').run(targetType, targetId); }
module.exports = { evaluate, isDenied, anyRulesExist, listRules, createRule, updateRule, deleteRule, deleteForTarget };
