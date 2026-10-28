import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const validPath = path => typeof path === 'string' && path.length > 0 && !path.includes('\0') && isAbsolute(path)
const within = (root, path) => {
  const tail = relative(root, path)
  return tail === '' || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail))
}

/**
 * Optional local-filesystem host adapter, not a locator resolver or recovery
 * authorization. The host must provide every current AND historical artifact
 * producer root in the same filesystem namespace as read.value.path. It must
 * keep that inventory and path mappings stable across the read/classification
 * interval; filesystem checks cannot establish that guarantee or eliminate
 * concurrent path replacement. Opaque/remote backends need their own adapter.
 *
 * No session tracker is consulted. Every call checks all roots again, so a
 * missing root, restart or empty registry cannot establish source provenance.
 */
export function createFilesystemReadClassifier({ sourceRoots = [], artifactRoots = [], artifactInventoryComplete = false } = {}) {
  for (const [name, roots] of Object.entries({ sourceRoots, artifactRoots })) {
    if (!Array.isArray(roots) || roots.some(path => !validPath(path))) throw new TypeError(`${name} must contain absolute filesystem paths`)
  }
  if (typeof artifactInventoryComplete !== 'boolean') throw new TypeError('artifactInventoryComplete must be boolean')
  // Copy host configuration so later array mutations cannot grant provenance.
  const sources = sourceRoots.map(path => resolve(path))
  const artifacts = artifactRoots.map(path => resolve(path))

  return Object.freeze({ async classify(inputPath) {
    let canonicalPath = null
    const result = (kind, reason, complete = false) => Object.freeze({ kind, reason,
      inputPath: typeof inputPath === 'string' ? inputPath : null, canonicalPath, complete })
    if (!validPath(inputPath)) return result('unknown', 'not-absolute-filesystem-path')
    if (!artifactInventoryComplete || !artifacts.length) return result('unknown', 'artifact-inventory-incomplete')
    try {
      const paths = [...sources, ...artifacts]
      const roots = await Promise.all(paths.map(async path => {
        const canonical = await realpath(path)
        if (!(await stat(canonical)).isDirectory()) throw new Error('Not a directory')
        await access(canonical, constants.R_OK | constants.X_OK)
        return canonical
      }))
      canonicalPath = await realpath(inputPath)
      const lexicalPath = resolve(inputPath)
      // Both the producer path and its resolved target are excluded. A symlink
      // inside an artifact root must not turn a recovery read into source.
      if (artifacts.some((root, index) => within(root, lexicalPath) || within(roots[sources.length + index], canonicalPath))) {
        return result('artifact', 'artifact-root', true)
      }
      const file = await stat(canonicalPath)
      if (!file.isFile()) return result('unknown', 'not-regular-file')
      if (file.nlink !== 1) return result('unknown', 'multiple-file-links')
      await access(canonicalPath, constants.R_OK)
      if (!sources.some((root, index) => within(root, lexicalPath) && within(roots[index], canonicalPath))) {
        return result('unknown', 'outside-source-roots')
      }
      return result('source', 'complete-host-inventory', true)
    } catch {
      return result('unknown', 'filesystem-verification-failed')
    }
  } })
}
