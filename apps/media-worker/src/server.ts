import { createServer, type Server } from 'node:http';
import { type Delivery, handleJob, type JobDeps } from './worker';

/**
 * The worker's side of Dapr's Pub/Sub building block (D129: nothing else of Dapr). Dapr's sidecar
 * pulls `media-jobs` through the media-worker subscription and posts each message here; our reply
 * tells it to ack (SUCCESS, DROP) or nack (RETRY) the message
 * (https://docs.dapr.io/reference/api/pubsub_api/). It listens on 127.0.0.1 only: nothing can
 * reach Joel's machine from outside.
 */
export const PUBSUB = 'media-jobs';
export const TOPIC = 'media-jobs';
export const ROUTE = '/media-jobs';
/** A job is a few ids; anything much bigger isn't one. */
const MAX_BODY = 64 * 1024;

/**
 * The subscription Dapr asks for at start. Raw payload: api-user and housekeeping publish plain
 * JSON, not CloudEvents (worker.yaml), so Dapr hands the bytes over as they are.
 */
export const SUBSCRIPTIONS = [
  {
    pubsubname: PUBSUB,
    topic: TOPIC,
    route: ROUTE,
    metadata: { rawPayload: 'true' },
  },
];

/**
 * The job inside Dapr's delivery: Dapr wraps a raw message in a CloudEvent, with the bytes in
 * `data_base64` (or, for some senders, the JSON itself in `data`). undefined if unreadable.
 */
export function jobFromDelivery(body: unknown): unknown {
  if (!body || typeof body !== 'object') return undefined;
  const event = body as Record<string, unknown>;
  try {
    if (typeof event['data_base64'] === 'string') {
      return JSON.parse(
        Buffer.from(event['data_base64'], 'base64').toString('utf8'),
      );
    }
    const data = event['data'];
    return typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    return undefined;
  }
}

export function workerServer(deps: JobDeps): Server {
  return createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/dapr/subscribe') {
      return reply(200, SUBSCRIPTIONS);
    }
    if (req.method !== 'POST' || req.url !== ROUTE) {
      return reply(404, {});
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      let body: unknown;
      if (!tooBig) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = undefined;
        }
      }
      handleJob(jobFromDelivery(body), deps).then(
        (status: Delivery) => reply(200, { status }),
        (err: unknown) => {
          // Our own bug: leave the job in the queue rather than lose it.
          deps.log({
            step: 'crashed',
            code: err instanceof Error ? err.name : 'error',
            delivery: 'RETRY',
          });
          reply(200, { status: 'RETRY' });
        },
      );
    });
  });
}
