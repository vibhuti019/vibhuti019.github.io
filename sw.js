/**
 * Portfolio Service Worker
 *
 * Caching strategies:
 *   Cache-First  — audio, images, fonts, Next.js static chunks
 *                  (content-hashed filenames, safe to serve from cache indefinitely)
 *   Network-First — HTML / navigation requests
 *                  (always try fresh, fall back to cached shell on offline)
 *
 * On every SW install the audio file and key public assets are precached
 * so the music is ready instantly on the second visit without any network round-trip.
 */

const CACHE_VERSION = 'portfolio-v1'

// Assets to eagerly download and cache on SW install.
// Keep this list small — only things every visitor needs.
const PRECACHE_URLS = [
  '/audio/background.opus',  // ← music — most important, ~620 KB
  '/og-image.png',
  '/image.jpeg',
]

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())  // activate immediately without waiting
  )
})

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          // Delete every cache that isn't the current version
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())  // take control of all open tabs immediately
  )
})

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Only handle same-origin + Google Fonts (cross-origin CDN)
  const isSameOrigin = url.origin === self.location.origin
  const isGoogleFont =
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'

  if (!isSameOrigin && !isGoogleFont) return

  // ── Cache-First: static assets (content-hashed or binary) ─────────────────
  const isStaticAsset =
    url.pathname.startsWith('/_next/static/') ||  // JS/CSS chunks (content-hashed)
    url.pathname.startsWith('/audio/') ||           // music
    url.pathname.startsWith('/_next/image') ||      // Next.js image optimizer
    isGoogleFont ||                                 // font files & CSS
    /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|opus|mp3|wav|pdf)$/i.test(
      url.pathname
    )

  if (isStaticAsset) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached

        // Not in cache yet — fetch and store for next time
        return fetch(request).then((response) => {
          if (response.ok || response.status === 0 /* opaque */) {
            const clone = response.clone()
            caches
              .open(CACHE_VERSION)
              .then((cache) => cache.put(request, clone))
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
        // Offline fallback — serve the cached shell page
        caches.match('/') || caches.match('/index.html')
      )
    )
  }

  // All other requests (API calls, analytics) — let the browser handle them normally
})
