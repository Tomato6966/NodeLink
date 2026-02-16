import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sendErrorResponse, sendResponse } from "../utils.js";
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function getEndpointConfig(nodelink) {
    const endpoint = nodelink.options?.cluster?.endpoint || {};
    const code = typeof endpoint.code === 'string' && endpoint.code.length > 0
        ? endpoint.code
        : 'CAPYBARA';
    return {
        patchEnabled: endpoint.patchEnabled === true,
        allowExternalPatch: endpoint.allowExternalPatch === true,
        code
    };
}
function parseLine(value, fallback = 1) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1)
        return fallback;
    return Math.floor(parsed);
}
async function handler(nodelink, req, res, _sendResponse, parsedUrl) {
    const endpointConfig = getEndpointConfig(nodelink);
    if (!endpointConfig.patchEnabled) {
        return sendErrorResponse(req, res, 403, 'Forbidden', 'Profiler endpoint is disabled.', parsedUrl.pathname);
    }
    const remoteAddress = req.socket?.remoteAddress || '';
    if (!endpointConfig.allowExternalPatch && !LOOPBACKS.has(remoteAddress)) {
        return sendErrorResponse(req, res, 403, 'Forbidden', 'External access to profiler file endpoint is blocked.', parsedUrl.pathname);
    }
    const code = parsedUrl.searchParams.get('code') ||
        (req.body && typeof req.body === 'object' ? req.body.code : undefined);
    if (!code || code !== endpointConfig.code) {
        return sendErrorResponse(req, res, 403, 'Forbidden', 'Invalid or missing profiler code.', parsedUrl.pathname);
    }
    const rawPath = parsedUrl.searchParams.get('path');
    if (!rawPath) {
        return sendErrorResponse(req, res, 400, 'Bad Request', 'Missing path query parameter.', parsedUrl.pathname);
    }
    const cwd = process.cwd();
    const parsedPath = rawPath.startsWith('file://')
        ? fileURLToPath(rawPath)
        : rawPath;
    const absolutePath = path.resolve(cwd, parsedPath);
    const normalizedCwd = `${cwd}${path.sep}`;
    if (absolutePath !== cwd &&
        !absolutePath.startsWith(normalizedCwd) &&
        !parsedPath.startsWith(normalizedCwd)) {
        return sendErrorResponse(req, res, 403, 'Forbidden', 'Path is outside the project root.', parsedUrl.pathname);
    }
    const line = parseLine(parsedUrl.searchParams.get('line'), 1);
    const context = Math.min(60, Math.max(3, parseLine(parsedUrl.searchParams.get('context'), 8)));
    try {
        const candidates = [absolutePath];
        if (absolutePath.includes(`${path.sep}dist${path.sep}`) &&
            absolutePath.endsWith('.js')) {
            candidates.push(absolutePath
                .replace(`${path.sep}dist${path.sep}`, `${path.sep}src${path.sep}`)
                .replace(/\.js$/i, '.ts'));
        }
        let resolvedPath = null;
        for (const candidate of candidates) {
            try {
                await fsPromises.access(candidate);
                resolvedPath = candidate;
                break;
            }
            catch { }
        }
        if (!resolvedPath)
            resolvedPath = absolutePath;
        const content = await fsPromises.readFile(resolvedPath, 'utf8');
        const lines = content.split('\n');
        const start = Math.max(1, line - context);
        const end = Math.min(lines.length, line + context);
        const snippet = [];
        for (let i = start; i <= end; i++) {
            snippet.push({
                number: i,
                text: lines[i - 1] ?? ''
            });
        }
        return sendResponse(req, res, {
            path: resolvedPath,
            line,
            start,
            end,
            totalLines: lines.length,
            snippet
        }, 200);
    }
    catch (error) {
        return sendErrorResponse(req, res, 404, 'Not Found', `Could not read file: ${error instanceof Error ? error.message : String(error)}`, parsedUrl.pathname);
    }
}
export default {
    handler,
    methods: ['GET']
};
