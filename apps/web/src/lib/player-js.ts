// Bunny Stream's player control API (https://docs.bunny.net/stream/playback-api): Player.js's
// postMessage protocol (github.com/embedly/player.js, SPEC.rst), spoken directly instead of
// loading Bunny's hosted script on our pages. Only what the cards need: hear when a player starts
// playing, and pause it. Messages are matched by the frame's own window, not its `src` (Bunny's
// docs warn that players sharing a `src` confuse the library's matching).

const CONTEXT = 'player.js';
const VERSION = '0.0.11';

interface Message {
  context?: unknown;
  event?: unknown;
}

function parse(data: unknown): Message | null {
  if (typeof data !== 'string') return null;
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

/**
 * Listens to the player in `frame`: `onPlay` runs each time it starts playing. Returns `pause`
 * (a no-op until the player is there) and `disconnect`.
 */
export function connectPlayer(
  frame: HTMLIFrameElement,
  onPlay: () => void,
): { pause: () => void; disconnect: () => void } {
  let origin: string;
  try {
    origin = new URL(frame.src).origin;
  } catch {
    return { pause: () => undefined, disconnect: () => undefined };
  }
  const send = (method: string, value?: string, listener?: string) =>
    frame.contentWindow?.postMessage(
      JSON.stringify({
        context: CONTEXT,
        version: VERSION,
        method,
        value,
        listener,
      }),
      origin,
    );
  let listening = false;
  const onMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || e.origin !== origin) return;
    const message = parse(e.data);
    if (message?.context !== CONTEXT) return;
    if (message.event === 'ready' && !listening) {
      listening = true;
      send('addEventListener', 'play', 'play');
    } else if (message.event === 'play') onPlay();
  };
  window.addEventListener('message', onMessage);
  // A player that was ready before this ran (the page's frames load before it hydrates) says
  // `ready` again when asked; one that isn't loaded yet says it once it is.
  send('addEventListener', 'ready', 'ready');
  return {
    pause: () => send('pause'),
    disconnect: () => window.removeEventListener('message', onMessage),
  };
}
