from collections.abc import AsyncIterator
from typing import Literal

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.ai.ollama import AIUnavailable, PageVerdict, ReasonVerdict
from app.config import Settings
from app.db import Base
from app.main import create_app


class FakeAI:
    """Stands in for Ollama so tests are fast, free and deterministic."""

    model = "fake-model"

    def __init__(self) -> None:
        self.classify_calls = 0
        self.down = False

    async def classify_page(self, domain: str, path: str, title: str) -> PageVerdict:
        if self.down:
            raise AIUnavailable("down")
        self.classify_calls += 1
        category = "study" if "algorithm" in title.lower() else "distraction"
        return PageVerdict(category=category, confidence=0.9, reason="fake verdict")

    async def judge_reason(
        self, domain: str, reason: str, minutes: int, asks_today: int, used_minutes: int
    ) -> ReasonVerdict:
        if self.down:
            raise AIUnavailable("down")
        return ReasonVerdict(allow="lecture" in reason.lower(), message="fake judgement")

    async def status(self) -> Literal["ready", "unavailable"]:
        return "unavailable" if self.down else "ready"


@pytest.fixture
def fake_ai() -> FakeAI:
    return FakeAI()


# Explicit async markers so the tests also run when pytest is started outside backend/.
@pytest_asyncio.fixture
async def client(fake_ai: FakeAI) -> AsyncIterator[AsyncClient]:
    app = create_app(Settings(database_url="sqlite+aiosqlite:///:memory:", ai_enabled=False))
    async with app.router.lifespan_context(app):
        # The in-memory SQLite DB lives as long as the engine, so create the schema directly.
        engine = app.state.sessionmaker.kw["bind"]
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        app.state.ai = fake_ai
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
            yield http
