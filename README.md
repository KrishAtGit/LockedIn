# LockedIn

A study-aware focus extension for uni students. It knows a lecture from a rabbit hole, gets stricter as your deadlines approach, and asks *why* before it blocks.

> Status: early development. Not on any extension store yet. Build from source (below); packaged releases are coming.

## Features

**Working now**
- Tracks active time per site. It only counts while you're actually using the browser, and audible tabs (lectures, videos) count too.
- Default limit of 60 min per site per day, with custom limits per site and a study allowlist that's never limited.
- A timer dial in the popup and a floating, draggable one on each site, showing the time left today. The ring drains as you use the site, its colour shows the AI's label for the page, and the numbers turn amber, then red, as time runs out. The on-page timer can be minimised or turned off.
- Warning notification a set number of minutes before time runs out.
- When the limit hits, the tab goes to a **"Need more time?"** page. You have to write a reason and wait, and the wait gets longer each time you ask.
- Every reason is logged so you can look back at your excuses.

**With the AI backend (optional, see [`backend/`](backend/README.md))**
- Each page is labelled study, distraction or neutral by a self-hosted FastAPI service: built-in rules first, then a cache, then a local Ollama model. No API keys or subscriptions. The label shows on the timer and in the popup.
- Study pages don't count toward limits and are never blocked, so a YouTube lecture is fine and YouTube Shorts aren't.
- Your reasons for more time are judged by the AI. Vague excuses get denied, and each denial makes the next wait longer.
- If the backend is down, the extension falls back to working exactly as it does without it.

**Planned**
- Focus sessions: lock in for 25 or 50 minutes with every distraction blocked.
- Quiet hours: distraction sites blocked at set times.
- Weekly report: time per site, study vs distraction, and your reasons for more time.
- Deadline-adaptive limits from Canvas / Moodle / Google Calendar.
- Backend deployed on AWS (ECS Fargate, RDS, Terraform, GitHub Actions).
- Chrome Web Store and Firefox Add-ons releases.

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

## Turn on the AI (optional)

1. Start Ollama and the backend (details in [`backend/README.md`](backend/README.md)):
   ```bash
   ollama serve                          # in one terminal
   cd backend && uv run uvicorn app.main:app   # in another
   ```
2. In the extension, open **Settings → AI backend**, tick **Use the AI backend**, and allow access to the server when Chrome asks.
3. **Test connection** should say *AI ready*.

## Development

```bash
npm run dev          # rebuilds dist/chrome on every save
npm run dev:firefox  # same for Firefox
npm run typecheck
npm run api:types    # regenerate TypeScript types from the backend's API after changing it
```

After a rebuild, hit the reload icon on the extension card in `chrome://extensions`.

## Project structure

```
backend/                # FastAPI API, see backend/README.md
docker-compose.yml      # API + Postgres
extension/
├── src/
│   ├── background.ts   # time tracking, limit enforcement, AI labels, grants
│   ├── content/timer.ts  # the floating on-page timer (built separately, see vite.content.config.ts)
│   ├── manifest.ts     # per-browser manifest (Chrome / Firefox)
│   ├── lib/
│   │   ├── ring.ts     # the timer dial (SVG) and countdown helpers
│   │   ├── api.ts      # backend client; api-types.ts is generated from its OpenAPI schema
│   │   └── …           # storage, page labels, domain matching, time helpers
│   ├── pages/          # popup, settings, and the "need more time?" page
│   └── public/icons/
└── scripts/make-icons.mjs
```

## Privacy

All tracking data stays in your browser (`storage.local`). With the AI backend turned on (it's off by default), the domain, path and title of the page you're on, and any reasons you type for more time, are sent to the server you configured, which you run yourself. Nothing is sent anywhere else.

## License

MIT
