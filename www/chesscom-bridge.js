/* chesscom-bridge.js — one API, two transports:
 *   direct — fetched straight from the WebView/browser (chess.com sends
 *            Access-Control-Allow-Origin: *, and Chromium's default
 *            User-Agent is what passes Cloudflare's check)
 *   proxy  — through the Node dev server, which sets an explicit browser UA
 *            and caches responses; used as a fallback when direct is blocked
 */

import * as cc from './chesscom.mjs';

/* Port 3000 is the dev server; anything else means the page is served by
 * Capacitor (https://localhost) where there is no server. */
const API_BASE = location.port === '3000' ? location.origin : 'http://localhost:3000';

/** Retry a direct call through the server when Cloudflare/HTTP blocks it. */
async function via(fn, proxyPath) {
  try {
    return await fn();
  } catch (err) {
    const retryable = err.blocked || err.offline || err.status;
    if (!retryable) throw err;
    return fn({ proxy: `${API_BASE}/api/chesscom` });
  }
}

export const chessCom = {
  search: (username) => via(() => cc.searchPlayer(username), `player/${username}`),
  games: (username, month) =>
    via(() => cc.listGames(username, month), `player/${username}/games/${month}`)
};
