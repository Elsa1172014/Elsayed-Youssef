# Android TV / Google TV / Fire TV

Native Android wrapper is **not yet implemented**. A production-ready build must:
- Provide an Android TV launcher activity and banner, remote focus and Back behavior.
- Load bundled web assets or a controlled HTTPS origin, never arbitrary untrusted URLs.
- Use a native playback engine (e.g. Media3 ExoPlayer) for formats unsupported by WebView.
- Protect authentication tokens and validate TLS; no embedded passwords.
- Produce signed APK/AAB artifacts and test on actual devices.

Do not describe this folder as an installable APK.
