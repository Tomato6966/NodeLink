// Example plugin demonstrating the public API
// Export either a default function (nodelink, api) => void
// or an object with register(nodelink, api)

export default async function examplePlugin(nodelink, api) {
  // Add a simple GET route: /v4/example-plugin/ping
  api.addRoute(`/v4/example-plugin/ping`, (server, req, res, sendResponse) => {
    sendResponse(req, res, { ok: true, plugin: 'example-plugin', pid: process.pid }, 200)
  }, ['GET'])

  // Log on load
  api.logger('info', 'Plugin', 'example-plugin initialized')
}

