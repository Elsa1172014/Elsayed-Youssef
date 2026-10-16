# Android TV test build

This is an Android TV WebView **starter app**, not yet a validated production player.
It opens the existing Smart Receiver HTTPS website with remote navigation.
The web site must implement remote-focus handling for a complete TV experience.
Existing production /v1/auth/login 404 is not fixed by this wrapper.

## Build
Open the `tv/android` directory in Android Studio (Android SDK 35, JDK 17).
Sync Gradle, then Build > Build APK(s). Android Studio outputs a debug APK under
`app/build/outputs/apk/debug/app-debug.apk`.
Install on Android TV / Google TV using Android Studio or `adb install`.
Test playback formats, CORS, login, D-pad, exit and Back on hardware.
Release distribution requires a signed build, launcher banner and store review.

This source is not a Samsung Tizen or LG webOS package.
