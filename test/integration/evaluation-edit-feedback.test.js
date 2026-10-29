import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgentFixture } from '../../scripts/evaluate-agent.js'
import { acceptanceFixtures } from '../fixtures/acceptance/tasks.js'
import { acceptanceReplayAdapter } from '../../scripts/acceptance-benchmark.js'

const issue = 'The file does not match the requested exact edit, including whitespace. Inspect and correct it, then read it again.'
function wrongEditAdapter({ repair = true } = {}) {
  return options => {
    const adapter = acceptanceReplayAdapter(options), stream = adapter.stream.bind(adapter)
    let feedbackCount = 0, callId = 0
    adapter.stream = async function* (request) {
      const feedback = request.messages.filter(message => message.role === 'user' && message.content?.some(block => block.type === 'text' && block.text.startsWith('Validation feedback:')))
      if (feedback.length > feedbackCount) { feedbackCount = feedback.length; adapter.index = 0 }
      for await (const chunk of stream(request)) {
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          const block = { ...chunk.block, id: `edit-feedback-${++callId}` }
          if (block.name === 'write' && (!repair || feedbackCount === 0)) {
            const args = JSON.parse(block.arguments)
            block.arguments = JSON.stringify({ ...args, content: args.content + '\n' })
          }
          yield { ...chunk, block }
        } else yield chunk
      }
    }
    return adapter
  }
}

for (const group of ['baseline-default', 'baseline-tuned', 'plugin']) {
  test(`exact edit mismatch receives bounded generic feedback and repairs through official tools: ${group}`, async () => {
    const fixture = acceptanceFixtures().find(task => task.id === 'changed-file')
    const result = await runAgentFixture(fixture, group, { replay: true, adapterFactory: wrongEditAdapter(), validationFeedbackLimit: 2, maxSteps: 12 })
    assert.equal(result.passed, true)
    assert.equal(result.fileCorrect, true)
    assert.equal(result.exactFacts, true)
    assert.deepEqual(result.feedback, [{ phase: 1, correction: 1, issues: [issue] }])
    assert.equal(result.drafts[1].exactFacts, true)
    assert.equal(result.modelCalls.length, 9)
    assert.equal(result.steps, 9)
    assert.equal(result.usageComplete, true)
    assert.equal(result.usage.inputTokens, 90)
    assert.equal(result.usage.outputTokens, 45)
    assert.equal(result.toolCalls.filter(call => call.name === 'write' && !call.isError).length, 2)
    assert.equal(result.toolCalls.filter(call => call.name === 'read' && call.phase === 1 && !call.isError).length, 2)
    assert.equal(JSON.stringify(result.feedback).includes('retryLimit'), false)
    assert.equal(JSON.stringify(result.feedback).includes('"after"'), false)
  })
}

for (const validationFeedbackLimit of [0, 2]) {
  test(`incorrect file still fails with feedback limit ${validationFeedbackLimit}`, async () => {
    const fixture = acceptanceFixtures().find(task => task.id === 'changed-file')
    const result = await runAgentFixture(fixture, 'baseline-tuned', { replay: true, adapterFactory: wrongEditAdapter({ repair: false }), validationFeedbackLimit, maxSteps: 12 })
    assert.equal(result.passed, false)
    assert.equal(result.fileCorrect, false)
    assert.equal(result.exactFacts, true)
    assert.equal(result.correctionCount, validationFeedbackLimit)
    assert.equal(result.modelCalls.length, 6 + 3 * validationFeedbackLimit)
    assert.equal(result.usageComplete, true)
    assert.equal(result.usage.inputTokens, 10 * result.modelCalls.length)
    assert.ok(result.feedback.every(row => row.phase === 1 && row.issues.length === 1 && row.issues[0] === issue))
  })
}
