/** In-memory, plugin-instance budgets keyed by the live Session object.
 * Reservations are conservative estimates, not hard provider invoice guarantees.
 * Restart/reopen creates a new trial; callers must budget those trials separately.
 */
export function createTrialBudgets(config) {
  const sessions = new WeakMap()
  return session => {
    if (session === null || typeof session !== 'object') return undefined
    if (sessions.has(session)) return sessions.get(session)
    let calls = 0
    let committedCost = 0
    let sealed = false
    const budget = {
      snapshot: () => ({ calls, committedCost, sealed, maxCalls: config.maxCalls, maxTotalCost: config.maxTotalCost }),
      reserve(upperEstimate) {
        if (sealed) return { reason: 'trial-budget-sealed' }
        if (calls >= config.maxCalls) return { reason: 'trial-call-budget' }
        if (committedCost + upperEstimate > config.maxTotalCost) return { reason: 'trial-cost-budget' }
        // No await between testing and reserving: concurrent executions cannot
        // each spend the same remaining allowance. Shared calls may over-reserve.
        calls++
        committedCost += upperEstimate
        return { settle(selection, actualCost) {
          if (selection?.llmCalled === false) {
            calls--
            committedCost = Math.max(0, committedCost - upperEstimate)
            return
          }
          // A declined stream may have emitted partial usage before cancellation
          // or adapter failure. Retain the reserve and seal rather than assume the
          // visible counters are the final bill. Paid failures still count.
          if (selection?.status !== 'selected' || !selection.usageComplete || actualCost === undefined) {
            committedCost += Math.max(0, (actualCost ?? 0) - upperEstimate)
            sealed = true
            return
          }
          committedCost = Math.max(0, committedCost - upperEstimate + actualCost)
          if (actualCost > upperEstimate || actualCost > config.maxCallCost || committedCost > config.maxTotalCost) sealed = true
        } }
      },
    }
    sessions.set(session, budget)
    return budget
  }
}
