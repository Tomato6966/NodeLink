import { Buffer } from 'node:buffer'
import { base64ToU8 } from './protor.js'

const PO_CONFIG = {
  apiKey: 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  clientVersion: '2.20260107.01.00',
  integrityUrl: 'https://www.youtube.com/api/jnn/v1/GenerateIT'
};

export class PoTokenManager {
  async generate(videoId) {
    try {
      const { visitorData, botguardData } = await this.getPageContext(videoId);
      const { snapshot } = await this.createSnapshot();
      const integrityToken = await this.requestIntegrityToken(snapshot, botguardData.requestKey);
      const poToken = await this.bindToken(integrityToken, visitorData);
      return { poToken, visitorData };
    } catch (error) {
      return { poToken: null, visitorData: null };
    }
  }

  async getPageContext(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': PO_CONFIG.userAgent }
    });
    const html = await res.text();
    const visitorDataMatch = html.match(/"visitorData":"([^"]+)"/);
    if (!visitorDataMatch) throw new Error('Could not find visitorData');
    const visitorData = visitorDataMatch[1];
    const stsMatch = html.match(/"signatureTimestamp":(\d+)/);
    const signatureTimestamp = stsMatch ? parseInt(stsMatch[1]) : 20455;

    const playerRes = await fetch('https://youtubei.googleapis.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': PO_CONFIG.userAgent,
        'X-Goog-Visitor-Id': visitorData
      },
      body: JSON.stringify({
        videoId,
        playbackContext: { contentPlaybackContext: { signatureTimestamp } },
        context: { client: { clientName: 'WEB', clientVersion: PO_CONFIG.clientVersion, visitorData, userAgent: PO_CONFIG.userAgent } }
      })
    });

    const body = await playerRes.json();
    const botguardData = body.botguardData || { requestKey: 'fixed_key' };
    return { visitorData, botguardData };
  }

  async createSnapshot() {
    const signals = new Uint8Array([0x12, 0x1a, 0x0a, 0x08, 0x01, 0x12, 0x04, 0x08, 0x01, 0x10, 0x01]);
    return { snapshot: Buffer.from(signals).toString('base64'), signals };
  }

  async requestIntegrityToken(snapshot, requestKey) {
    const res = await fetch(PO_CONFIG.integrityUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json+protobuf', 
        'X-Goog-Api-Key': PO_CONFIG.apiKey,
        'X-User-Agent': 'grpc-web-javascript/0.1'
      },
      body: JSON.stringify([requestKey, snapshot])
    });
    const body = await res.json();
    return body[0];
  }

  async bindToken(integrityToken, visitorData) {
    const itBytes = base64ToU8(integrityToken);
    const vdBytes = Buffer.from(visitorData, 'utf8');
    const buffer = new Uint8Array(10 + itBytes.length + vdBytes.length);
    buffer[0] = 0x22; buffer[1] = buffer.length - 2;
    buffer.set([0x5a, 0xb3, 0x00, 0x01], 2);
    new DataView(buffer.buffer, 6, 4).setUint32(0, Math.floor(Date.now() / 1000), false);
    buffer.set(itBytes, 10); buffer.set(vdBytes, 10 + itBytes.length);
    const payload = buffer.subarray(2);
    for (let i = 2; i < payload.length; i++) payload[i] ^= i % 2 === 0 ? 0x5a : 0xb3;
    return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}