import { sendResponse } from '../utils.js';

function getStatus(nodelink, req, res) {
  const routePlanner = nodelink.routePlanner;
  const now = Date.now();

  const failingAddresses = [];
  for (const [ip, expiry] of routePlanner.bannedIps.entries()) {
    if (now < expiry) {
      const cooldown = routePlanner.config.bannedIpCooldown || 600000;
      const failingTimestamp = expiry - cooldown;
      failingAddresses.push({
        failingAddress: ip,
        failingTimestamp: failingTimestamp,
        failingTime: new Date(failingTimestamp).toString(),
      });
    }
  }

  const status = {
    class: 'BalancingIpRoutePlanner', // Reflects the current implementation
    details: {
      ipBlock: {
        type: routePlanner.config.ipBlocks[0]?.includes(':') ? 'Inet6Address' : 'Inet4Address',
        size: routePlanner.ipBlocks.length,
      },
      failingAddresses: failingAddresses,
      strategy: routePlanner.config.strategy || 'RotateOnBan',
      currentAddress: null, // N/A for balancing planner
      blockIndex: null,     // N/A for balancing planner
      ipIndex: null         // N/A for balancing planner
    },
  };

  sendResponse(req, res, status, 200);
}

function freeAddress(nodelink, req, res) {
  const { address } = req.body;

  if (!address) {
    return sendResponse(req, res, {
      timestamp: Date.now(),
      status: 400,
      error: 'Bad Request',
      message: 'The address field is required.',
      path: req.url
    }, 400);
  }

  nodelink.routePlanner.freeIP(address);
  res.writeHead(204);
  res.end();
}

function freeAll(nodelink, req, res) {
  nodelink.routePlanner.freeAll();
  res.writeHead(204);
  res.end();
}

const routes = {
  '/v4/routeplanner/status': {
    'GET': getStatus
  },
  '/v4/routeplanner/free/address': {
    'POST': freeAddress
  },
  '/v4/routeplanner/free/all': {
    'POST': freeAll
  }
};

function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const route = routes[parsedUrl.pathname];
  if (route) {
    const methodHandler = route[req.method];
    if (methodHandler) {
      return methodHandler(nodelink, req, res);
    }
  }

  return sendResponse(req, res, {
    timestamp: Date.now(),
    status: 404,
    error: 'Not Found',
    message: 'The requested route planner endpoint was not found.',
    path: parsedUrl.pathname
  }, 404);
}

export default {
  handler,
  methods: ['GET', 'POST'],
};