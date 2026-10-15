# LockedIn

A study-aware focus extension for uni students. It knows a lecture from a rabbit hole, gets stricter as your deadlines approach, and asks *why* before it blocks.

> Status: early development (week 1 of 4). Not on any extension store. Install from GitHub Releases or build from source.

## Features

**Working now**
- Tracks active time per site. It only counts while you're actually using the browser, and audible tabs (lectures, videos) count too.
- Default limit of 60 min per site per day, with custom limits per site and a study allowlist that's never limited.
- Warning notification before time runs out.
- When the limit hits, the tab goes to a **"Need more time?"** page. You have to write a reason and wait, and the wait gets longer each time you ask.
- Every reason is logged so you can look back at your excuses.

**Planned**
- AI intent classification: YouTube lecture = study, YouTube Shorts = distraction.
- Deadline-adaptive limits from Canvas / Moodle / Google Calendar.
- AI judging your "need more time" reasons.
- Self-hostable backend (Docker) plus a deployed AWS instance (Terraform).
- Weekly insights report.

## Install (from source)

Requires Node 20+.

```bash
cd extension
npm install
npm run build        # outputs dist/chrome and dist/firefox
```

**Chrome / Edge / Brave**
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick `extension/dist/chrome`.

**Firefox**
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and pick `extension/dist/firefox/manifest.json`.
   (Temporary add-ons are removed when Firefox restarts. Signed builds will come with Releases.)

## Development

```bash
npm run dev          # rebuilds dist/chrome on every save
npm run dev:firefox  # same for Firefox
npm run typecheck
```

After a rebuild, hit the reload icon on the extension card in `chrome://extensions`.

## Project structure

```
extension/
├── src/
│   ├── background.ts   # time tracking, limit enforcement, grants
│   ├── manifest.ts     # per-browser manifest (Chrome / Firefox)
│   ├── lib/            # storage, domain matching, time helpers
│   ├── pages/          # popup, options, and the "need more time?" page
│   └── public/icons/
└── scripts/make-icons.mjs
```

## Privacy

All tracking data stays in your browser (`storage.local`). Nothing is sent anywhere.

## License

MIT
