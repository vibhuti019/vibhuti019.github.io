/**
 * Portfolio Service Worker
 *
 * Caching strategies:
 *   Cache-First  — audio, images, fonts, Next.js static chunks
 *   Network-First — HTML / navigation requests
 *
 * Audio/Range-request handling:
 *   Browsers split large audio files into multiple Range requests (e.g. 64 KB chunks).
 *   The Cache API refuses to store 206 Partial Content responses.
 *
 *   Solution:
 *     1. On first request for an audio file, fetch the FULL file (no Range header)
 *        and cache the 200 response.
 *     2. For every Range request thereafter, slice the cached ArrayBuffer and
 *        construct a synthetic 206 response — 0 network bytes, instant seek.
 */

const CACHE_VERSION = 'portfolio-v3'

const PRECACHE_URLS = [
  '/audio/background.opus',
  '/og-image.png',
  '/image.jpeg',
]

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  )
})

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  )
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a Range header value (e.g. "bytes=0-65535") against a total size.
 * Returns { start, end } clamped to [0, total-1].
 */
function parseRange(rangeHeader, totalBytes) {
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/)
  if (!match) return null
  const start = match[1] !== '' ? parseInt(match[1], 10) : totalBytes - parseInt(match[2], 10)
  const end   = match[2] !== '' ? parseInt(match[2], 10) : totalBytes - 1
  return {
    start: Math.max(0, start),
    end:   Math.min(totalBytes - 1, end),
  }
}

/**
 * Serve a Range request from a cached full-file Response.
 * Reads the full ArrayBuffer, slices the requested bytes, and
 * returns a synthetic 206 response that the browser accepts normally.
 */
async function serveRangeFromCache(cachedResponse, rangeHeader) {
  const buffer    = await cachedResponse.arrayBuffer()
  const total     = buffer.byteLength
  const range     = parseRange(rangeHeader, total)

  if (!range) {
    // Malformed Range header — return full file as 200
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type':   cachedResponse.headers.get('Content-Type') || 'audio/opus',
        'Content-Length': String(total),
      },
    })
  }

  const { start, end } = range
  const sliced = buffer.slice(start, end + 1)

  return new Response(sliced, {
    status: 206,
    headers: {
      'Content-Type':   cachedResponse.headers.get('Content-Type') || 'audio/opus',
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Content-Length': String(sliced.byteLength),
      'Accept-Ranges':  'bytes',
    },
  })
}

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  const isSameOrigin = url.origin === self.location.origin
  const isGoogleFont =
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'

  if (!isSameOrigin && !isGoogleFont) return

  // ── Audio files — full cache + synthetic Range serving ────────────────────
  const isAudio = url.pathname.startsWith('/audio/')

  if (isAudio) {
    const rangeHeader = request.headers.get('range')

    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        // Always look up the base URL (no Range), since we cache the full file
        const cacheKey     = new Request(url.pathname)
        const cachedFull   = await cache.match(cacheKey)

        if (cachedFull) {
          // Full file is cached — synthesize the Range slice, 0 network bytes
          if (rangeHeader) {
            return serveRangeFromCache(cachedFull.clone(), rangeHeader)
          }
          return cachedFull
        }

        // Not in cache — fetch the FULL file (strip Range header) and cache it
        const fullFetch = await fetch(new Request(url.pathname))
        if (fullFetch.status === 200) {
          await cache.put(cacheKey, fullFetch.clone())
        }

        // Now serve from the freshly cached copy (or the raw response if fetch failed)
        const freshCached = await cache.match(cacheKey)
        if (freshCached && rangeHeader) {
          return serveRangeFromCache(freshCached.clone(), rangeHeader)
        }
        return fullFetch
      })
    )
    return
  }

  // ── Cache-First: other static assets ──────────────────────────────────────
  const isStaticAsset =
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/_next/image')   ||
    isGoogleFont                               ||
    /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|pdf)$/i.test(url.pathname)

  if (isStaticAsset) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached
        return fetch(request).then((response) => {
          if (response.status === 200 || response.status === 0) {
            const clone = response.clone()
            caches.open(CACHE_VERSION).then((c) => c.put(request, clone))
          }
          return response
        })
      })
    )
    return
  }

  // ── Network-First: HTML navigation ────────────────────────────────────────
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/') || caches.match('/index.html')
      )
    )
  }
})
