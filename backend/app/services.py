import logging
import re
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app import rules
from app.ai.ollama import AIClient, AIUnavailable
from app.db import Classification
from app.schemas import ClassifyRequest, ClassifyResponse, JudgeRequest, JudgeResponse, Stats

log = logging.getLogger(__name__)

# Errors that mean "the database is unreachable or broken". The cache is an optimisation,
# so on these the API keeps answering without it instead of failing the request.
DB_ERRORS = (SQLAlchemyError, OSError)


@dataclass
class Counters:
    """In-process request counters for /stats. They reset when the server restarts."""

    classify_requests: int = 0
    rules: int = 0
    cache_hits: int = 0
    ai_calls: int = 0
    fallbacks: int = 0


def cache_key(domain: str, path: str, title: str) -> str:
    # The first path segment separates e.g. /watch from /shorts without making every URL unique.
    segment = path.strip("/").split("/", 1)[0][:50]
    return f"{domain}|{segment}|{rules.normalize_title(title)}"


async def classify_page(
    req: ClassifyRequest, session: AsyncSession, ai: AIClient | None, counters: Counters
) -> ClassifyResponse:
    """Rules first (free, instant), then the cache, then the model. Falls back to neutral if the model is down."""
    counters.classify_requests += 1
    domain = req.domain.lower().removeprefix("www.")

    if verdict := rules.classify(domain, req.path, req.title):
        counters.rules += 1
        return ClassifyResponse(
            category=verdict.category, confidence=verdict.confidence, reason=verdict.reason, source="rules"
        )

    key = cache_key(domain, req.path, req.title)
    try:
        cached = await session.scalar(select(Classification).where(Classification.cache_key == key))
        if cached:
            cached.hits += 1
            await session.commit()
    except DB_ERRORS as err:
        log.warning("Cache lookup skipped, database unavailable: %s", err)
        cached = None
    if cached:
        counters.cache_hits += 1
        return ClassifyResponse(
            category=cached.category, confidence=cached.confidence, reason=cached.reason, source="cache"
        )

    if ai is None:
        counters.fallbacks += 1
        return ClassifyResponse(category="neutral", confidence=0, reason="AI is turned off", source="fallback")

    try:
        result = await ai.classify_page(domain, req.path, req.title)
    except AIUnavailable:
        counters.fallbacks += 1
        return ClassifyResponse(category="neutral", confidence=0, reason="AI is unavailable", source="fallback")

    counters.ai_calls += 1
    session.add(
        Classification(
            cache_key=key,
            domain=domain,
            title=req.title[:300],
            category=result.category,
            confidence=result.confidence,
            reason=result.reason,
            model=ai.model,
        )
    )
    try:
        await session.commit()
    except IntegrityError:
        # Another request classified the same page at the same moment. Its row is just as good.
        await session.rollback()
    except DB_ERRORS as err:
        log.warning("Result not cached, database unavailable: %s", err)
        await session.rollback()
    return ClassifyResponse(
        category=result.category, confidence=result.confidence, reason=result.reason, source="ai"
    )


LAZY_REASON = re.compile(
    r"\b(one more|bored|boring|deserve|i want|idk|dunno|chill|relax|for fun|because)\b", re.IGNORECASE
)
MAX_FALLBACK_ASKS = 3


def judge_by_rules(req: JudgeRequest) -> JudgeResponse:
    """Used when the model is off or down: allow specific-sounding reasons, deny excuses and repeat asks."""
    if req.asks_today >= MAX_FALLBACK_ASKS:
        return JudgeResponse(
            allow=False, message=f"That's {req.asks_today} asks today already. Time to step away.", source="fallback"
        )
    if LAZY_REASON.search(req.reason) or len(req.reason.split()) < 4:
        return JudgeResponse(
            allow=False, message="That doesn't sound like something that can't wait.", source="fallback"
        )
    return JudgeResponse(allow=True, message=f"Okay, {req.minutes} more minutes. Make them count.", source="fallback")


async def judge_reason(req: JudgeRequest, ai: AIClient | None) -> JudgeResponse:
    if ai is None:
        return judge_by_rules(req)
    try:
        verdict = await ai.judge_reason(req.domain, req.reason, req.minutes, req.asks_today, req.used_minutes)
    except AIUnavailable:
        return judge_by_rules(req)
    return JudgeResponse(allow=verdict.allow, message=verdict.message, source="ai")


async def stats(session: AsyncSession, counters: Counters) -> Stats:
    needed_ai = counters.cache_hits + counters.ai_calls
    try:
        cached_pages = await session.scalar(select(func.count()).select_from(Classification)) or 0
    except DB_ERRORS:
        cached_pages = 0
    return Stats(
        classify_requests=counters.classify_requests,
        rules=counters.rules,
        cache_hits=counters.cache_hits,
        ai_calls=counters.ai_calls,
        fallbacks=counters.fallbacks,
        cache_hit_rate=round(counters.cache_hits / needed_ai, 3) if needed_ai else 0.0,
        cached_pages=cached_pages,
    )
