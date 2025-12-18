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
      }
      async search(query) { return { loadType: 'empty', data: {} }; }
      async resolve(url) { return { loadType: 'empty', data: {} }; }
      async getTrackUrl(trackInfo) { return { exception: { message: 'Not implemented', severity: 'fault' } }; }
    }
    nodelink.registerSource('mysource', new MyCustomSource(nodelink));

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
