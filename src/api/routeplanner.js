import { logger, sendResponse } from '../utils.js';

function getStatus(nodelink, req, res) {
  const status = {
    class: nodelink.routePlanner.constructor.name,
    details: {
      ipBlock: {
        type: nodelink.routePlanner.config.ipBlocks[0]?.type || 'Unknown',
        size: nodelink.routePlanner.ipBlocks.length,
      },
      failingAddresses: nodelink.routePlanner.bannedIps.size,
      strategy: nodelink.routePlanner.config.strategy,
    },
  };

  sendResponse(req, res, status, 200);
}

function freeAddress(nodelink, req, res) {
  const { address } = req.body;

  if (!address) {
    return sendResponse(req, res, { message: 'Address not provided' }, 400);
  }

  nodelink.routePlanner.freeIP(address);
  sendResponse(req, res, { message: `Freed address: ${address}` }, 200);
}

function freeAll(nodelink, req, res) {
  nodelink.routePlanner.freeAll();
  sendResponse(req, res, { message: 'Freed all addresses' }, 200);
}

function handler(nodelink, req, res, sendResponse, parsedUrl) {
  if (req.method === 'GET') {
    return getStatus(nodelink, req, res);
  }

  if (req.method === 'POST') {
    if (parsedUrl.pathname.endsWith('/free')) {
      return freeAddress(nodelink, req, res);
    }

    if (parsedUrl.pathname.endsWith('/free/all')) {
      return freeAll(nodelink, req, res);
    }
  }

  sendResponse(req, res, { message: 'Invalid method' }, 405);
}

export default {
  handler,
  methods: ['GET', 'POST'],
};
