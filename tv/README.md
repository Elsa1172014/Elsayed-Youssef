# Smart Receiver TV — cross-platform groundwork

This is an **initial TV interface scaffold**, not a built or installable TV application.

## Shared TV experience
- D-pad spatial focus navigation via `remote-navigation.js`
- Focus visibility, larger remote-friendly targets via `tv.css`
- Existing React IPTV web UI and backend APIs are intended to be reused.

## Platform deliverables (not yet built)
- Android TV / Google TV / Fire TV: Android application package with Leanback launcher support and appropriate playback engine.
- Samsung: signed Tizen web application (.wgt), test on actual Samsung model.
- LG: webOS packaged application (.ipk), test on actual LG model.

## Integration
A TV-only entrypoint should import `./remote-navigation.js` and `./tv.css`, set `document.documentElement.classList.add('tv-mode')`, then call `installTvRemoteNavigation()`. Do not enable this globally on the existing web site.

## Release gates
1. Restore/verify live backend API and authentication: production `/v1/auth/login` previously returned 404.
2. Verify permitted channel streams, CORS, DRM and codecs on each platform.
3. Verify TV remote navigation, Back/Exit behavior, login persistence, and 1080p/4K layouts.
4. Sign each package, test on hardware, follow vendor installation/distribution requirements.
5. Keep current production deployment unchanged until explicit approval.
