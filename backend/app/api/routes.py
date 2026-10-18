from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app import services
from app.ai.ollama import AIClient
from app.db import session_scope
from app.schemas import ClassifyRequest, ClassifyResponse, Health, JudgeRequest, JudgeResponse, Stats

router = APIRouter()


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    async for session in session_scope(request.app.state.sessionmaker):
        yield session


def get_ai(request: Request) -> AIClient | None:
    return request.app.state.ai


def get_counters(request: Request) -> services.Counters:
    return request.app.state.counters


Session = Annotated[AsyncSession, Depends(get_session)]
AI = Annotated[AIClient | None, Depends(get_ai)]
Counters = Annotated[services.Counters, Depends(get_counters)]


@router.get("/health", response_model=Health, tags=["meta"])
async def health(session: Session, ai: AI) -> Health:
    try:
        await session.execute(text("SELECT 1"))
        database = True
    except Exception:
        database = False
    return Health(
        status="ok",
        database=database,
        ai=await ai.status() if ai else "disabled",
        model=ai.model if ai else None,
    )


@router.post("/classify", response_model=ClassifyResponse, tags=["focus"])
async def classify(req: ClassifyRequest, session: Session, ai: AI, counters: Counters) -> ClassifyResponse:
    """Labels a page as study, distraction or neutral."""
    return await services.classify_page(req, session, ai, counters)


@router.post("/judge-reason", response_model=JudgeResponse, tags=["focus"])
async def judge_reason(req: JudgeRequest, ai: AI) -> JudgeResponse:
    """Decides whether a reason for more time on a site is good enough."""
    return await services.judge_reason(req, ai)


@router.get("/stats", response_model=Stats, tags=["meta"])
async def stats(session: Session, counters: Counters) -> Stats:
    """How requests were answered since the server started, including the cache hit rate."""
    return await services.stats(session, counters)
