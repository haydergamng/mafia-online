'use strict';
const crypto = require('node:crypto');
const TYPES = ['mafia', 'doctor', 'detective', 'citizen'];
const roleLabels = {mafia:'مافيا',doctor:'طبيب',detective:'محقق',citizen:'مواطن'};

function totalRoles(counts) {
  return TYPES.reduce((sum, role) => sum + counts[role], 0);
}
function rolesValid(counts, capacity) {
  return Number.isSafeInteger(capacity) && capacity >= 3 && capacity <= 500 &&
    TYPES.every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0 && counts[k] <= capacity) &&
    totalRoles(counts) <= capacity;
}
function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function assignRoles(ids, counts) {
  if (!rolesValid(counts, ids.length) || totalRoles(counts) !== ids.length || counts.mafia < 1 || counts.mafia >= ids.length) {
    throw new Error('يجب أن تتساوى الأدوار مع اللاعبين مع وجود مافيا ولاعب بريء على الأقل.');
  }
  const roles = shuffle(TYPES.flatMap(role => Array(counts[role]).fill(role)));
  return new Map(ids.map((id, i) => [id, roles[i]]));
}
function mostVoted(votes, eligible, tieMode='none') {
  const allowed = new Set(eligible);
  const totals = new Map();
  for (const target of Object.values(votes)) {
    if (allowed.has(target)) totals.set(target, (totals.get(target)||0)+1);
  }
  if (!totals.size) return null;
  const high = Math.max(...totals.values());
  const tied = [...totals.entries()].filter(([,count]) => count === high).map(([id]) => id);
  return tied.length === 1 ? tied[0] : (tieMode === 'random' ? tied[crypto.randomInt(tied.length)] : null);
}
function winner(players) {
  const alive = players.filter(p => p.alive);
  const mafia = alive.filter(p => p.role === 'mafia').length;
  if (mafia === 0) return 'citizens';
  if (mafia >= alive.length - mafia) return 'mafia';
  return null;
}
module.exports = {TYPES, roleLabels, totalRoles, rolesValid, assignRoles, mostVoted, winner};
