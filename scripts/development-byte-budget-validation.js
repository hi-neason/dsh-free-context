import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

export const BYTE_BUDGET_VALIDATION_VERSION = 'json-output-utf8-v1'
const strings = [
  ...Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)),
  '\b\t\n\f\r', '"', '\\', '中文', '😀', '\ud800', '\udfff',
]
const cases = strings.map(value => ({ schema: [`key${value}`], rows: [[value], [value]] }))
cases.push(
  { schema: ['long_key_'.repeat(64), 'other'], rows: Array.from({ length: 24 }, (_, i) => [i, null]) },
  { schema: ['nested', '__proto__'], rows: [[{ text: '\u0001中文😀', list: [null, true, { '\ud800': '\\' }] }, 1], [{ text: '"', list: [] }, false]] },
)
export const BYTE_BUDGET_VALIDATION_CASES = cases.length * 2

async function main() {
  // Candidate code is imported only here, in the externally bounded process.
  const { decodeJsonRows } = await import(pathToFileURL(process.argv[2]).href)
  let passedCases = 0
  for (const { schema, rows } of cases) {
    const input = JSON.stringify({ format: 'dsh-json-rows', version: 1, schema, rows })
    const expected = JSON.stringify(rows.map(row => Object.fromEntries(schema.map((key, i) => [key, row[i]]))))
    const bytes = Buffer.byteLength(expected, 'utf8')
    try {
      assert.equal(decodeJsonRows(input, { maxOutputBytes: bytes }), expected)
      passedCases++
    } catch { /* Count every failure without exposing hidden case data. */ }
    try {
      assert.throws(() => decodeJsonRows(input, { maxOutputBytes: bytes - 1 }), RangeError)
      passedCases++
    } catch { /* Count every failure without exposing hidden case data. */ }
  }
  const result = { version: BYTE_BUDGET_VALIDATION_VERSION, cases: BYTE_BUDGET_VALIDATION_CASES,
    passedCases, failedCases: BYTE_BUDGET_VALIDATION_CASES - passedCases }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = result.failedCases === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
