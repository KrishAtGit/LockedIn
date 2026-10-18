# LockedIn API

FastAPI service that the extension asks two questions:

- **`POST /classify`**: is this page study, distraction or neutral?
- **`POST /judge-reason`**: is this reason for more time good enough?

Everything runs on your machine. The AI is a local [Ollama](https://ollama.com) model, so there are no API keys or subscriptions.

## How a page gets classified

```
request ─▶ built-in rules ─▶ cache (Postgres) ─▶ Ollama ─▶ save to cache
              │ known site        │ seen before      │ down or slow?
              ▼                   ▼                  ▼
           instant             ~3 ms            neutral fallback
```

1. **Rules** (`app/rules.py`) answer obvious cases for free: LMS and `.edu` sites, social media, YouTube Shorts, known subreddits, and titles that try to give the classifier orders.
2. **Cache**: every AI verdict is stored by domain + path + normalised title, so the same page is never sent to the model twice. `(3) Lecture 6 - YouTube` and `Lecture 6 - YouTube` share one entry.
3. **Ollama** gets the rest, with output constrained to a JSON schema.
4. **Fallback**: if Ollama is off, slow or broken, the API still answers using the rules.

`GET /stats` reports how requests were answered and the cache hit rate. `GET /health` checks the database and whether the model is pulled.

## Run it

**With Docker** (API + Postgres):

```bash
brew install ollama && ollama serve       # in its own terminal
ollama pull llama3.2:3b
docker compose up --build                 # from the repo root
```

API at http://localhost:8000, interactive docs at http://localhost:8000/docs.

**Without Docker** (for development):

```bash
uv sync
cp .env.example .env                      # point LOCKEDIN_DATABASE_URL at a Postgres
uv run alembic upgrade head
uv run uvicorn app.main:app --reload
```

To run with no AI at all, set `LOCKEDIN_AI_ENABLED=false`.

## Tests and evaluation

```bash
uv run pytest                             # rules, cache, fallbacks and validation, with a fake model
uv run python -m scripts.eval_classifier  # accuracy of the real model on 20 labelled pages
uv run python -m scripts.eval_classifier qwen2.5:7b   # compare another model
```

Current result: `llama3.2:3b` labels **18/20 (90%)** of pages correctly with no help from rules, at a median **~500 ms** per page on an M-series Mac. The rules now catch both pages it missed.
