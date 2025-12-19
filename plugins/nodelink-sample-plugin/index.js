/**
 * NodeLink Plugin Entry Point
 *
 * This file demonstrates the structure and capabilities of a NodeLink plugin.
 * Plugins are loaded in both the Master process and Worker processes.
 *
 * @param {import('../../src/index').NodelinkServer} nodelink - The main server instance.
 * @param {Object} config - The specific configuration for this plugin defined in 'pluginConfig' within config.js.
 * @param {Object} context - Metadata about the execution environment.
 */
export default async function(nodelink, config, context) {
  const logger = (msg, level = 'info') => nodelink.logger(level, `Plugin:${context.pluginName}`, msg);

  logger(`Initializing in ${context.type.toUpperCase()} mode.`);

  // =================================================================================
  // CONTEXT: MASTER
  // Executed only once in the main process.
  // =================================================================================
  if (context.type === 'master') {
    logger('Running Master setup...');

    // 1. Registering a Custom API Route
    nodelink.registerRoute('GET', '/v4/sample/status', (nodelink, req, res, sendResponse) => {
      sendResponse(req, res, {
        status: 'ok',
        message: 'Hello from NodeLink Sample Plugin!',
        version: context.meta.version
      }, 200);
    });

    // Test helper: create a test player in a worker (uses mock session inside worker)
    nodelink.registerRoute('POST', '/v4/sample/create-test-player', async (nodelink, req, res, sendResponse) => {
      try {
        const body = req.body || {}
        const sessionId = body.sessionId || 'test-session'
        const guildId = body.guildId || '11111111111111111'
        const voice = body.voice || null
        const payload = { sessionId, guildId, userId: body.userId || 'test-user', voice }
        const worker = nodelink.workerManager.getBestWorker()
        if (!worker) return sendResponse(req, res, { error: 'No worker available' }, 500)
        const result = await nodelink.workerManager.execute(worker, 'createPlayer', payload)
        sendResponse(req, res, { result }, 200)
      } catch (e) {
        sendResponse(req, res, { error: e.message }, 500)
      }
    })

    // Test helper: attempt to load a mysource track and play it on a test player
    nodelink.registerRoute('POST', '/v4/sample/play-mysource', async (nodelink, req, res, sendResponse) => {
      try {
        const body = req.body || {}
        const sessionId = body.sessionId || 'test-session'
        const guildId = body.guildId || '11111111111111111'
        const worker = nodelink.workerManager.getBestWorker()
        if (!worker) return sendResponse(req, res, { error: 'No worker available' }, 500)

        // create mock player
        await nodelink.workerManager.execute(worker, 'createPlayer', { sessionId, guildId, userId: body.userId || 'test-user' })

        // try resolving via mysource
        const load = await nodelink.workerManager.execute(worker, 'loadTracks', { identifier: 'mysource:dummy' })

        // if empty, return load result (nothing to play)
        if (!load || load.loadType === 'empty' || (load.data && (!load.data.tracks || load.data.tracks.length === 0))) {
          return sendResponse(req, res, { load }, 200)
        }

        const track = load.data.tracks[0]

        // send play command to worker player
        const playRes = await nodelink.workerManager.execute(worker, 'playerCommand', {
          sessionId,
          guildId,
          command: 'play',
          args: [{ info: track }]
        })

        sendResponse(req, res, { load, play: playRes }, 200)
      } catch (e) {
        sendResponse(req, res, { error: e.message }, 500)
      }
    })

    // 2. Intercepting Player Commands (Master Side)
    // This allows you to block or modify play/stop/pause/seek/volume commands before they reach the worker.
    nodelink.registerPlayerInterceptor(async (action, guildId, args) => {
      // logger(`Intercepted player action '${action}' for guild ${guildId}`, 'debug');

      if (action === 'play') {
        const track = args[0];
        // Example: Block playing a specific track
        if (track?.info?.title?.includes('Forbidden Song')) {
          logger(`Blocked playback of forbidden song for guild ${guildId}`, 'warn');
          return { error: 'This song is forbidden by plugin.' }; // Returns this to the caller immediately
        }
      }
      return null; // Continue execution
    });
  }

  // =================================================================================
  // CONTEXT: WORKER
  // Executed in every worker process (if cluster is enabled).
  // =================================================================================
  if (context.type === 'worker') {
    logger('Running Worker setup...');

    // 1. Registering a Custom Audio Source
    class MyCustomSource {
      constructor(nodelink) {
        this.nodelink = nodelink;
        this.sourceName = 'mysource';
        this.searchTerms = ['mysource'];
      }
      async search(query) { return { loadType: 'empty', data: {} }; }
      async resolve(url) { return { loadType: 'empty', data: {} }; }
      async getTrackUrl(trackInfo) { return { exception: { message: 'Not implemented', severity: 'fault' } }; }
    }
    const mySrc = new MyCustomSource(nodelink);
    nodelink.registerSource('mysource', mySrc);
    // Ensure the source can be used via the `source:query` syntax by mapping a search term
    try {
      nodelink.sources.searchTermMap.set('mysource', 'mysource')
    } catch (e) {
      if (nodelink.sources && nodelink.sources.searchTermMap) {
        nodelink.sources.searchTermMap.set('mysource', 'mysource')
      }
    }

    // 2. Registering a Custom Audio Filter
    class SimpleGainFilter {
      constructor() { this.gain = 1.0; }
      update(config) { if (config.simpleGain) this.gain = config.simpleGain; }
      process(chunk) { return chunk; }
    }
    nodelink.registerFilter('simpleGain', new SimpleGainFilter());

    // 3. Registering an Audio Interceptor (Low Level)
    const { Transform } = await import('node:stream');
    nodelink.registerAudioInterceptor(() => {
      return new Transform({
        transform(chunk, encoding, callback) {
          callback(null, chunk);
        }
      });
    });

    // 4. Intercepting Worker Commands (Worker Side)
    // This intercepts internal IPC commands sent from Master to Worker.
    nodelink.registerWorkerInterceptor(async (type, payload) => {
      // logger(`Worker received command: ${type}`, 'debug');

      if (type === 'destroyPlayer') {
        // Example: Log before destroying
        // logger(`Destroying player for guild ${payload.guildId} in worker...`, 'debug');
      }

      return false; // Return true to block the command
    });
  }
}
