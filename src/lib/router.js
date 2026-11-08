'use strict';

/**
 * Minimal router: exact segments and `:param` segments, plus a trailing `*` wildcard.
 * Each route runs a chain of async handlers (middleware first). A handler stops the chain
 * by finishing the response.
 */
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, ...handlers) {
    const segments = pattern.split('/').filter(Boolean);
    this.routes.push({ method, segments, handlers });
    return this;
  }

  get(p, ...h) { return this.add('GET', p, ...h); }
  post(p, ...h) { return this.add('POST', p, ...h); }
  put(p, ...h) { return this.add('PUT', p, ...h); }
  patch(p, ...h) { return this.add('PATCH', p, ...h); }
  delete(p, ...h) { return this.add('DELETE', p, ...h); }

  /** Returns { handlers, params } or { methodNotAllowed: true } or null. */
  match(method, pathname) {
    let parts;
    try {
      parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return null;
    }
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      pathMatched = true;
      if (route.method === '*' || route.method === method || (method === 'HEAD' && route.method === 'GET')) {
        return { handlers: route.handlers, params };
      }
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

function matchSegments(segments, parts) {
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === '*') {
      params.wildcard = parts.slice(i).join('/');
      return params;
    }
    if (i >= parts.length) return null;
    if (seg.startsWith(':')) params[seg.slice(1)] = parts[i];
    else if (seg !== parts[i]) return null;
  }
  return segments.length === parts.length ? params : null;
}

async function runChain(handlers, req, res) {
  for (const h of handlers) {
    await h(req, res);
    if (res.writableEnded || res.headersSent) return;
  }
}

module.exports = { Router, runChain };
