// Example plugin demonstrating the public API
// Export either a default function (nodelink, api) => void
// or an object with register(nodelink, api)

export const pluginInfo = {
  name: 'example-plugin',
  description: 'Example plugin demonstrating the public API',
  version: '1.0.0'
}

export default async function examplePlugin(nodelink, pluginApi) {
  // Add a simple GET route: /v4/example-plugin/ping
  pluginApi.addRoute(
    `/v4/example-plugin/ping`,
    (server, req, res, sendResponse) => {
      sendResponse(
        req,
        res,
        { ok: true, plugin: 'example-plugin', pid: process.pid },
        200
      )
    },
    ['GET']
  )

  // Log on load
  pluginApi.logger('info', 'Plugin', 'example-plugin initialized')
}

// Also attach metadata to the default export for discovery
examplePlugin.pluginInfo = pluginInfo
