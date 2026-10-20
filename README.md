# LockedIn

**A study-aware focus extension for university students.**

LockedIn distinguishes lectures from distractions, adapts to your study habits, and adds friction when you try to exceed your limits. Before granting more time, it asks one question: **Why?**

> **Status:** Early development. Not yet available on browser extension stores. Install from source using the instructions below.

## Features

### Working

- **Per-site time tracking** — Tracks active browsing time and counts audible tabs, including lectures and videos.
- **Daily time limits** — Starts with a default limit of 60 minutes per site, with custom limits and an unrestricted study allowlist.
- **Visual timers** — Displays a countdown dial in the popup and a draggable floating timer on web pages. The ring reflects the page's AI classification, while the remaining time changes from normal to amber and red.
- **Configurable warnings** — Sends a notification a specified number of minutes before a limit is reached.
- **Intentional time extensions** — Redirects you to a *Need more time?* page when a limit is reached. You must provide a reason and wait before continuing, with longer waits for repeated requests.
- **Excuse history** — Logs every request for additional time so you can review your decisions later.

### Optional AI backend

The AI backend adds page classification and reason evaluation through a self-hosted FastAPI service.

- **Context-aware page classification** — Labels pages as `study`, `distraction`, or `neutral` using built-in rules, a cache, and a local Ollama model.
- **Study-friendly browsing** — Study pages are excluded from time limits and blocking. For example, a YouTube lecture can remain accessible while YouTube Shorts are restricted.
- **AI-evaluated extensions** — Evaluates your reasons for requesting more time. Vague justifications can be denied, increasing the wait before the next request.
- **Local AI inference** — Uses Ollama without requiring external AI API keys or subscriptions.
- **Graceful fallback** — If the backend is unavailable, the extension continues working without AI features.

See [`backend/README.md`](backend/README.md) for setup instructions.

### Planned

- **Focus sessions** — 25- and 50-minute sessions that block distractions.
- **Quiet hours** — Automatically restrict distracting sites during scheduled periods.
- **Weekly reports** — Review time spent per site, study-versus-distraction breakdowns, and extension requests.
- **Deadline-aware limits** — Adapt limits using deadlines from Canvas, Moodle, and Google Calendar.
- **Cloud deployment** — Deploy the backend using AWS ECS Fargate, RDS, Terraform, and GitHub Actions.
- **Browser store releases** — Publish on the Chrome Web Store and Firefox Add-ons.

---

## Installation

### Prerequisites

- Node.js 20 or later

### 1. Build the extension

```bash
cd extension
npm install
npm run build
```

The build outputs are generated in `extension/dist/chrome` and `extension/dist/firefox`.

### 2. Load in your browser

<details>
<summary><strong>Chrome, Edge, and Brave</strong></summary>

1. Open `chrome://extensions` or the equivalent extensions page in your browser.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the `extension/dist/chrome` directory.

</details>

<details>
<summary><strong>Firefox</strong></summary>

1. Open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on**.
3. Choose `extension/dist/firefox/manifest.json`.

Temporary add-ons are removed when Firefox restarts. Signed builds are planned for future releases.

</details>

---

## Enabling the AI backend

The AI backend is optional. The extension works without it.

### 1. Start the services

Start Ollama in one terminal:

```bash
ollama serve
```

Start the FastAPI backend in another:

```bash
cd backend
uv run uvicorn app.main:app
```

Follow [`backend/README.md`](backend/README.md) for model setup, configuration, and any additional service requirements.

### 2. Connect the extension

1. Open the extension's **Settings → AI backend**.
2. Enable **Use the AI backend**.
3. Allow the requested server access when prompted by your browser.
4. Select **Test connection** and confirm that the status reports *AI ready*.

---

## Development

Run these commands from the `extension/` directory.

| Command | Description |
|---|---|
| `npm run dev` | Rebuilds the Chrome extension when files change |
| `npm run dev:firefox` | Rebuilds the Firefox extension when files change |
| `npm run typecheck` | Checks TypeScript types |
| `npm run api:types` | Regenerates TypeScript types from the backend's OpenAPI schema |

After rebuilding, open `chrome://extensions` and click the reload icon on the LockedIn extension card to apply the changes.

### Project structure

```text
backend/                  # FastAPI backend
  └── README.md            # Backend setup and configuration

docker-compose.yml         # API and PostgreSQL services

extension/
├── src/
│   ├── background.ts      # Time tracking, limits, AI labels, and grants
│   ├── content/
│   │   └── timer.ts       # Floating on-page timer
│   ├── manifest.ts        # Chrome and Firefox manifests
│   ├── lib/
│   │   ├── ring.ts        # SVG timer dial and countdown helpers
│   │   ├── api.ts         # Backend client
│   │   ├── api-types.ts   # Generated API types
│   │   └── ...            # Storage, labels, and time utilities
│   ├── pages/             # Popup, settings, and extension-limit page
│   └── public/icons/      # Extension icons
└── scripts/
    └── make-icons.mjs     # Icon generation
```

---

## Privacy

**Your browsing data stays local by default.**

- **Local storage:** Tracking data is stored in your browser using `storage.local`.
- **Optional backend:** When enabled, the extension sends the current page's domain, path, title, and any reasons you submit to the server you configure.
- **Self-hosted processing:** You control the backend and where it runs.
- **No third-party transmission:** The extension does not intentionally send this data to other services.

The AI backend is disabled by default. Review the backend configuration and network behaviour before using it with sensitive browsing data.

---

## License

Released under the [MIT License](LICENSE).
