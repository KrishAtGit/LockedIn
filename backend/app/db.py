from collections.abc import AsyncIterator
from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String, func
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.pool import StaticPool


class Base(DeclarativeBase):
    pass


class Classification(Base):
    """A cached AI verdict for one page, so the same page is never sent to the model twice."""

    __tablename__ = "classifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    cache_key: Mapped[str] = mapped_column(String(600), unique=True, index=True)
    domain: Mapped[str] = mapped_column(String(253))
    title: Mapped[str] = mapped_column(String(300))
    category: Mapped[str] = mapped_column(String(20))
    confidence: Mapped[float] = mapped_column(Float)
    reason: Mapped[str] = mapped_column(String(300))
    model: Mapped[str] = mapped_column(String(100))
    hits: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


def make_sessionmaker(database_url: str) -> tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
    if ":memory:" in database_url:
        # Every new connection to an in-memory SQLite DB starts empty, so tests share a single one.
        engine = create_async_engine(database_url, poolclass=StaticPool)
    else:
        engine = create_async_engine(database_url, pool_pre_ping=True)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def session_scope(maker: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    async with maker() as session:
        yield session
