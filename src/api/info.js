import process from 'node:process'
import { getVersion } from '../utils.js'

async function handler(nodelink, req, res, sendResponse) {
  const enabledFilters = nodelink.options.filters.enabled || {}
  const filters = Object.keys(enabledFilters).filter(
    (key) => enabledFilters[key]
  )

  const response = {
    version: {
      semver: `${nodelink.version}`,
      ...getVersion('object')
    },
    buildTime: nodelink.gitInfo.commitTime,
    git: nodelink.gitInfo,
    node: process.version,
    voice: {
      name: '@performanc/voice',
      version: 'github:PerformanC/voice'
    },
    sourceManagers: nodelink.workerManager
      ? nodelink.supportedSourcesCache ||
        (nodelink.supportedSourcesCache = await nodelink.getSourcesFromWorker())
      : (nodelink.sources?.sources && Array.from(nodelink.sources.sources.keys())) || [],
    filters,
    plugins: (() => {
      const pm = nodelink.pluginManager
      // Prefer detailed list if available
      if (pm && Array.isArray(pm.plugins)) {
        return pm.plugins.map((p) => {
          if (typeof p === 'string') return { name: p, version: 'unknown', description: 'unknown' }
          return {
            name: p?.name || 'unknown',
            version: p?.version || 'unknown',
            description: p?.description || 'unknown'
          }
        })
      }
      if (pm && typeof pm.getPluginList === 'function') {
        return pm.getPluginList().map((name) => ({ name, version: 'unknown', description: 'unknown' }))
      }
      return []
    })()
  }
  sendResponse(req, res, response, 200)
}

export default {
  handler
}
