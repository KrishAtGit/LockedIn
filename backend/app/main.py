from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.ai.ollama import OllamaClient
from app.api.routes import router
from app.config import Settings, get_settings
from app.db import make_sessionmaker
from app.services import Counters


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine, app.state.sessionmaker = make_sessionmaker(settings.database_url)
        ai = (
            OllamaClient(settings.ollama_url, settings.ollama_model, settings.ollama_timeout_seconds)
            if settings.ai_enabled
            else None
        )
        app.state.ai = ai
        app.state.counters = Counters()
        yield
        if ai:
            await ai.close()
        await engine.dispose()

    app = FastAPI(
        title="LockedIn API",
        version="0.1.0",
        description="Classifies pages as study or distraction and judges requests for more time.",
        lifespan=lifespan,
    )
    # Only the extension's own pages may call the API from a browser.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(chrome-extension|moz-extension|safari-web-extension)://[a-zA-Z0-9-]+$",
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )
    app.include_router(router)
    return app


app = create_app()
