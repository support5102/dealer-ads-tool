/**
 * Adjustment Store — in-memory storage for pending budget adjustments.
 *
 * Called by: routes/budget-adjustments.js
 *
 * Stores adjustment batches with auto-expiry (24 hours).
 * Tracks lifecycle: pending → approved → executed, or pending → rejected/expired.
 */

const STATUSES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  EXECUTED: 'executed',
};

class AdjustmentStore {
  constructor() {
    /** @type {Map<string, Object>} adjustmentId → adjustment batch */
    this._store = new Map();
    // Expire check every 5 minutes (unref so it doesn't block process exit)
    this._expiryInterval = setInterval(() => this._expireStale(), 5 * 60 * 1000);
    if (this._expiryInterval.unref) this._expiryInterval.unref();
  }

  /**
   * Saves an adjustment batch.
   * @param {Object} batch - From generateExecutableAdjustments()
   */
  save(batch) {
    this._store.set(batch.adjustmentId, {
      ...batch,
      status: STATUSES.PENDING,
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectedReason: null,
      executionResults: null,
      executedAt: null,
    });
  }

  /**
   * Gets an adjustment batch by ID.
   * @param {string} id
   * @returns {Object|null}
   */
  get(id) {
    return this._store.get(id) || null;
  }

  /**
   * Lists all adjustments, optionally filtered by status.
   * @param {string} [status] - Filter by status
   * @returns {Object[]} Sorted by generatedAt descending (newest first)
   */
  list(status) {
    const items = Array.from(this._store.values());
    const filtered = status ? items.filter(a => a.status === status) : items;
    return filtered.sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
  }

  /**
   * Lists pending adjustments for a specific account.
   * @param {string} customerId
   * @returns {Object[]}
   */
  listForAccount(customerId) {
    return Array.from(this._store.values())
      .filter(a => a.customerId === customerId && a.status === STATUSES.PENDING);
  }

  /**
   * Marks an adjustment as approved.
   * @param {string} id
   * @param {string} email - Approver email
   * @returns {Object|null} Updated batch or null if not found/not pending
   */
  approve(id, email) {
    const batch = this._store.get(id);
    if (!batch || batch.status !== STATUSES.PENDING) return null;

    // Check expiry
    if (new Date() > new Date(batch.expiresAt)) {
      batch.status = STATUSES.EXPIRED;
      return null;
    }

    batch.status = STATUSES.APPROVED;
    batch.approvedBy = email;
    batch.approvedAt = new Date().toISOString();
    return batch;
  }

  /**
   * Marks an adjustment as rejected.
   * @param {string} id
   * @param {string} email - Rejecter email
   * @param {string} [reason] - Rejection reason
   * @returns {Object|null}
   */
  reject(id, email, reason) {
    const batch = this._store.get(id);
    if (!batch || batch.status !== STATUSES.PENDING) return null;

    batch.status = STATUSES.REJECTED;
    batch.rejectedBy = email;
    batch.rejectedAt = new Date().toISOString();
    batch.rejectedReason = reason || null;
    return batch;
  }

  /**
   * Records execution results for an approved adjustment.
   * @param {string} id
   * @param {Object} results - { applied, failed, details[] }
   */
  recordExecution(id, results) {
    const batch = this._store.get(id);
    if (!batch || batch.status !== STATUSES.APPROVED) return null;

    batch.status = STATUSES.EXECUTED;
    batch.executedAt = new Date().toISOString();
    batch.executionResults = results;
    return batch;
  }

  /**
   * Expires stale pending adjustments and evicts old terminal entries (>48h).
   */
  _expireStale() {
    const now = new Date();
    const EVICTION_MS = 48 * 60 * 60 * 1000; // 48 hours
    const terminal = [STATUSES.EXECUTED, STATUSES.REJECTED, STATUSES.EXPIRED];

    for (const [id, batch] of this._store) {
      if (batch.status === STATUSES.PENDING && new Date(batch.expiresAt) < now) {
        batch.status = STATUSES.EXPIRED;
      }
      // Evict old terminal entries to prevent unbounded memory growth
      if (terminal.includes(batch.status)) {
        const age = now - new Date(batch.generatedAt);
        if (age > EVICTION_MS) {
          this._store.delete(id);
        }
      }
    }
  }

  /**
   * Clears all stored adjustments (for testing).
   */
  clear() {
    this._store.clear();
  }

  /**
   * Stops the expiry interval (for cleanup).
   */
  destroy() {
    clearInterval(this._expiryInterval);
    this._store.clear();
  }

  get size() {
    return this._store.size;
  }
}

// Singleton instance
const store = new AdjustmentStore();

module.exports = { AdjustmentStore, store, STATUSES };
