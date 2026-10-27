// Opt-in response-contract check only. It never reads expected answer facts.
export function containsPlaceholder(value) {
  const pending = [value]
  const placeholder = /^(?:unknown|unavailable|unspecified|null|n\/a|not (?:available|found|provided|specified|present)(?: in (?:the )?(?:source|output|result))?|unable to (?:determine|find|locate))\.?$/i
  while (pending.length) {
    const item = pending.pop()
    if (item === null || typeof item === 'string' && (!item.trim() || placeholder.test(item.trim()))) return true
    if (item && typeof item === 'object') pending.push(...Object.values(item))
  }
  return false
}
