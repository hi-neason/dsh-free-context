const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const tool = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })

function answerFrom(text) {
  const match = text.match(/Revision: ([^.\n]+)\. Checkpoint value: (-?\d+(?:\.\d+)?)\./)
  if (!match) throw new Error('Missing model-visible version/checkpoint header')
  return { type: 'text', text: JSON.stringify({ revision: match[1], checkpoint: Number(match[2]) }) }
}

// Intentionally destructure only the adapter class: source paths, expected
// answers and snapshot callbacks supplied by the runner are not evidence.
export function retirementDiscoveryAdapter({ LlmAdapter }) {
  return new class extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      const results = request.messages.filter(message => message.role === 'tool')
      const sourceRead = results.find(message => message.toolCallId === 'read-source')
      const snapshotRead = results.find(message => message.toolCallId === 'read-snapshot')
      let block
      if (!results.length) block = tool('fixture-1', 'fixture', {})
      else if (!sourceRead) {
        const locator = results.map(textOf).join('\n').match(/^Original fixture path: ([^\n]+)$/m)?.[1]
        if (!locator) throw new Error('Missing model-visible original source locator')
        block = tool('read-source', 'read', { file_path: locator, offset: 1, limit: 1 })
      } else {
        const reference = results.map(textOf).join('\n').match(/Original tool-result snapshot: (\{[^\n]+\})/)?.[1]
        if (reference && !snapshotRead) {
          const { locator } = JSON.parse(reference)
          if (typeof locator !== 'string') throw new Error('Missing model-visible snapshot locator')
          block = tool('read-snapshot', 'read', { file_path: locator, offset: 1, limit: 1 })
        } else block = answerFrom(textOf(snapshotRead ?? sourceRead))
      }
      yield* events(block)
    }
  }()
}

export function retirementDiscoveryPtcAdapter({ LlmAdapter }) {
  return new class extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      const result = request.messages.find(message => message.role === 'tool')
      const block = result ? answerFrom(textOf(result)) : tool('batch-1', 'run_code', {
        code: `const content = await tools.fixture({});
const text = content.filter(block => block.type === 'text').map(block => block.text).join('\\n');
const locator = text.match(/^Original fixture path: ([^\\n]+)$/m)?.[1];
if (!locator) throw new Error('Missing original source locator');
const header = await tools.read({file_path: locator, offset: 1, limit: 1});
console.log(text);
console.log(JSON.stringify(header));`,
        description: 'Discover the source and read its header in one batch', timeoutMs: 15000,
      })
      yield* events(block)
    }
  }()
}

function* events(block) {
  yield { type: 'block-start', index: 0, blockType: block.type }
  yield { type: 'block-end', index: 0, block }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
}
