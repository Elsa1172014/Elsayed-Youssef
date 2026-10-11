# Curated official / FAST channel list

`official.json` is loaded with `npm run sync-official -- ../../catalog/official.json` (in `services/api`).
It is intentionally empty: add an entry only after verifying that the stream URL is published by the channel
itself (official site/app) or by a FAST provider whose terms permit third-party players.

```json
[
  {
    "id": "example-news",
    "name": "Example News",
    "provenance": "official",            // official | fast | fta
    "country": "QA",
    "languages": ["ara"],
    "categories": ["news"],
    "logo": "https://example.org/logo.png",
    "website": "https://example.org",
    "streams": [{ "url": "https://example.org/live/master.m3u8", "quality": "720p" }]
  }
]
```

Entries with an unknown provenance, no valid http(s) stream, or missing id/name are dropped.
Never add a stream that is paid, encrypted, or obtained by circumventing access controls.
