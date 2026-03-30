const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.json');
const MAX_ENTRIES = 200;

// In-process write lock to prevent concurrent read-modify-write races
let writeLock = Promise.resolve();

function ensureDataDir() {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) {
    console.warn('Failed to load history:', e.message);
    return [];
  }
}

function saveHistory(entries) {
  ensureDataDir();
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2));
}

function generateId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

function withLock(fn) {
  const next = writeLock.then(fn, fn);
  writeLock = next.catch(() => {});
  return next;
}

function addHistoryEntry(entry) {
  return withLock(() => {
    const entries = loadHistory();
    entry.id = entry.id || generateId();
    entries.unshift(entry);
    saveHistory(entries);
    return entry;
  });
}

function getHistory(limit = 50) {
  const entries = loadHistory();
  return entries.slice(0, limit);
}

function updateHistoryEntryById(id, updates) {
  return withLock(() => {
    const entries = loadHistory();
    const entry = entries.find(e => e.id === id);
    if (!entry) return null;
    Object.assign(entry, updates);
    saveHistory(entries);
    return entry;
  });
}

module.exports = { addHistoryEntry, getHistory, updateHistoryEntryById, loadHistory, generateId };
