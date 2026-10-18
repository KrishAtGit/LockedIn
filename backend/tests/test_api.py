import pytest
from httpx import AsyncClient

from tests.conftest import FakeAI

pytestmark = pytest.mark.asyncio


async def test_health(client: AsyncClient) -> None:
    body = (await client.get("/health")).json()
    assert body == {"status": "ok", "database": True, "ai": "ready", "model": "fake-model"}


async def test_rules_answer_without_calling_ai(client: AsyncClient, fake_ai: FakeAI) -> None:
    body = (await client.post("/classify", json={"domain": "www.instagram.com"})).json()
    assert body["category"] == "distraction"
    assert body["source"] == "rules"
    assert fake_ai.classify_calls == 0


async def test_ai_result_is_cached(client: AsyncClient, fake_ai: FakeAI) -> None:
    page = {"domain": "youtube.com", "path": "/watch", "title": "Algorithms that changed the world"}
    first = (await client.post("/classify", json=page)).json()
    # Same video, different notification count in the title: should still hit the cache.
    second = (await client.post("/classify", json={**page, "title": "(2) " + page["title"]})).json()

    assert first == {"category": "study", "confidence": 0.9, "reason": "fake verdict", "source": "ai"}
    assert second["source"] == "cache"
    assert second["category"] == "study"
    assert fake_ai.classify_calls == 1

    stats = (await client.get("/stats")).json()
    assert stats["ai_calls"] == 1
    assert stats["cache_hits"] == 1
    assert stats["cache_hit_rate"] == 0.5
    assert stats["cached_pages"] == 1


async def test_classify_falls_back_when_ai_is_down(client: AsyncClient, fake_ai: FakeAI) -> None:
    fake_ai.down = True
    body = (await client.post("/classify", json={"domain": "unknown.site", "title": "hello"})).json()
    assert body["category"] == "neutral"
    assert body["source"] == "fallback"


async def test_classify_validates_input(client: AsyncClient) -> None:
    assert (await client.post("/classify", json={"domain": ""})).status_code == 422
    assert (await client.post("/classify", json={"domain": "a.com", "title": "x" * 501})).status_code == 422


async def test_judge_uses_ai(client: AsyncClient) -> None:
    req = {"domain": "youtube.com", "reason": "Finishing the week 6 lecture", "minutes": 15}
    body = (await client.post("/judge-reason", json=req)).json()
    assert body == {"allow": True, "message": "fake judgement", "source": "ai"}


async def test_judge_fallback_rules(client: AsyncClient, fake_ai: FakeAI) -> None:
    fake_ai.down = True

    async def judge(reason: str, asks_today: int = 0) -> dict:
        req = {"domain": "youtube.com", "reason": reason, "minutes": 5, "asks_today": asks_today}
        return (await client.post("/judge-reason", json=req)).json()

    assert (await judge("Submitting my SIT315 report on the portal"))["allow"] is True
    assert (await judge("just one more video"))["allow"] is False
    assert (await judge("bored lol"))["allow"] is False
    assert (await judge("Submitting my SIT315 report on the portal", asks_today=3))["allow"] is False
    assert (await judge("Submitting my report"))["source"] == "fallback"


async def test_classify_still_answers_when_database_is_down(client: AsyncClient, fake_ai: FakeAI) -> None:
    # Simulate a lost database by dropping the cache table out from under the API.
    engine = client._transport.app.state.sessionmaker.kw["bind"]  # type: ignore[attr-defined]
    async with engine.begin() as conn:
        await conn.exec_driver_sql("DROP TABLE classifications")

    page = {"domain": "youtube.com", "path": "/watch", "title": "Minecraft But Every Block Is Random"}
    response = await client.post("/classify", json=page)
    assert response.status_code == 200
    assert response.json()["source"] == "ai"
    assert (await client.get("/stats")).status_code == 200
