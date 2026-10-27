import { acceptanceFixturesV2 } from './tasks-v2.js'

const clarification = ' Use retained tool excerpts when they explicitly support the requested fields. If evidence is missing, use the available read tool on the immutable original or supplied snapshot. Do not guess or return placeholders such as UNKNOWN or null. Preserve literal source field spellings and case, including diagnostic severity. Return only the originally requested JSON schema.'

// Prospective protocol: old v2 tasks and reports are never re-scored with this contract.
export function acceptanceFixturesV3() {
  return acceptanceFixturesV2().map(task => {
    if (!task.experiment || task.adoptionRequired === false) return task
    const fixture = { ...task, requireFixtureEachPhase: true, rejectPlaceholderValues: task.experiment !== 'diagnostic-evidence',
      phases: task.phases.map(phase => ({ ...phase, query: phase.query + clarification })) }
    if (fixture.experiment === 'diagnostic-evidence') {
      const blocks = fixture.text.split('\n\n')
      const info = blocks.slice(0, 24)
      fixture.text = [...info.slice(0, 8), blocks[24], ...info.slice(8, 16), blocks[25], ...info.slice(16), blocks[26]].join('\n\n')
    }
    return fixture
  })
}
