from typing import Literal

from pydantic import BaseModel, Field

Category = Literal["study", "distraction", "neutral"]
# Where a verdict came from, so the extension (and you, debugging) can tell how it was decided.
Source = Literal["rules", "cache", "ai", "fallback"]


class ClassifyRequest(BaseModel):
    domain: str = Field(min_length=1, max_length=253, examples=["youtube.com"])
    path: str = Field(default="/", max_length=2000, examples=["/watch"])
    title: str = Field(default="", max_length=500, examples=["Lecture 6: Dynamic Programming - MIT 6.006"])


class ClassifyResponse(BaseModel):
    category: Category
    confidence: float = Field(ge=0, le=1)
    reason: str
    source: Source


class JudgeRequest(BaseModel):
    domain: str = Field(min_length=1, max_length=253, examples=["youtube.com"])
    reason: str = Field(min_length=1, max_length=500, examples=["Finishing the last 10 minutes of the week 6 lecture"])
    minutes: int = Field(ge=1, le=120, examples=[15])
    asks_today: int = Field(default=0, ge=0, le=100, description="Extra-time requests already made today for this site")
    used_minutes: int = Field(default=0, ge=0, le=1440, description="Minutes already spent on this site today")


class JudgeResponse(BaseModel):
    allow: bool
    message: str = Field(description="One short line shown to the student")
    source: Literal["ai", "fallback"]


class Health(BaseModel):
    status: Literal["ok"]
    database: bool
    ai: Literal["ready", "unavailable", "disabled"]
    model: str | None


class Stats(BaseModel):
    classify_requests: int
    rules: int
    cache_hits: int
    ai_calls: int
    fallbacks: int
    cache_hit_rate: float = Field(description="Share of requests that needed AI but were answered from cache")
    cached_pages: int
