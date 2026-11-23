import { createHash } from 'node:crypto';
import { secretsMatch } from '../shared/jwt.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const actorId = /^[a-zA-Z0-9_-]{1,32}$/;
const statuses = new Set(['MATCHING', 'ASSIGNED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELED', 'MATCH_FAILED']);

export async function initializeInbox(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_event_inbox (
      sequence BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
      event_id CHAR(36) NOT NULL UNIQUE,
      order_id CHAR(36) NOT NULL,
      order_version INT UNSIGNED NOT NULL,
      payload JSON NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      processed_at DATETIME(3) NULL,
      KEY pending_projection (processed_at, sequence)
    ) ENGINE=InnoDB`);
}

function isEvent(event) {
  const snapshot = event?.snapshot;
  return event?.type === 'OrderSnapshotChanged' && event.schemaVersion === 1 &&
    typeof event.eventId === 'string' && uuid.test(event.eventId) &&
    typeof event.orderId === 'string' && uuid.test(event.orderId) &&
    Number.isSafeInteger(event.orderVersion) && event.orderVersion >= 1 && event.orderVersion <= 4294967295 &&
    typeof event.occurredAt === 'string' && Number.isFinite(Date.parse(event.occurredAt)) &&
    snapshot?.orderId === event.orderId && snapshot.orderVersion === event.orderVersion &&
    statuses.has(snapshot.status) && typeof snapshot.passengerId === 'string' && actorId.test(snapshot.passengerId) &&
    (snapshot.driverId === null || (typeof snapshot.driverId === 'string' && actorId.test(snapshot.driverId)));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function respond(response, code, errorCode) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(errorCode ? JSON.stringify({ error: { code: errorCode } }) : undefined);
}

export function createInboxHandler(pool, token) {
  return async (request, response) => {
    const provided = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1];
    if (!provided || !secretsMatch(provided, token)) return respond(response, 401, 'UNAUTHORIZED');
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
      return respond(response, 415, 'UNSUPPORTED_MEDIA_TYPE');
    }

    let event;
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > 32768) {
          request.resume();
          return respond(response, 413, 'BODY_TOO_LARGE');
        }
        chunks.push(chunk);
      }
      event = JSON.parse(Buffer.concat(chunks));
      if (!isEvent(event)) return respond(response, 400, 'INVALID_EVENT');
    } catch {
      return respond(response, 400, 'INVALID_EVENT');
    }

    try {
      const payload = stableJson(event);
      const hash = createHash('sha256').update(payload).digest('hex');
      await pool.execute(`
        INSERT INTO order_event_inbox (event_id, order_id, order_version, payload, payload_hash)
        VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE event_id = order_event_inbox.event_id`,
      [event.eventId, event.orderId, event.orderVersion, payload, hash]);
      const [[stored]] = await pool.execute('SELECT payload_hash FROM order_event_inbox WHERE event_id = ?', [event.eventId]);
      return stored.payload_hash === hash
        ? respond(response, 204) : respond(response, 409, 'EVENT_CONFLICT');
    } catch (error) {
      console.error('[order-inbox]', event.orderId, event.eventId, error.code ?? error.name);
      return respond(response, 503, 'UNAVAILABLE');
    }
  };
}
