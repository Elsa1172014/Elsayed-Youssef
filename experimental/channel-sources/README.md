# Isolated channel-source module (development only)

This directory is deliberately independent of the existing IPTV UI, player, routes, database and production settings.

## Current status
- No live streams have been added or verified.
- No source is enabled.
- No existing application file has been changed.
- This is a safe staging scaffold, **not** an IPTV playback integration.

## Integration contract
Each source requires: id, name, category, region, sourceUrl, sourceType (hls|dash|official_embed), rightsVerified, rightsNotes, enabled, lastCheckedAt.

Only enable sources when there is an official, authorized playback URL and the distribution terms permit use in this application. Free-to-air satellite transmission does not imply online rebroadcast rights.

## Future implementation
1. Identify the actual IPTV application source and production commit.
2. Add a read-only adapter that reads this catalog without changing existing channel records.
3. Add a dedicated, opt-in UI section with age gating and applicable regional compliance.
4. Test playback and security on Preview; verify no regression in existing channels.
5. Merge only after explicit production approval.

Never bypass DRM, subscription checks, geo-access restrictions or third-party anti-hotlink protections.
