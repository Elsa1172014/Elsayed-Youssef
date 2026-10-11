# Android / Android TV (Kotlin, Jetpack Compose, Media3)

A minimal client: lists the user's channels and plays HLS directly from each stream's origin with Media3/ExoPlayer.
Declares the Leanback launcher so it appears on Android TV.

**Status: source skeleton, not yet compiled or run in CI** (no Android SDK in the build environment). Open `apps/android` in Android Studio, set `API_BASE` (default `http://10.0.2.2:3000` for the emulator; production must be HTTPS), and run.

**Not on the release path:** the product is the web app (store publishing was cancelled by the owner). Kept as an optional skeleton.
