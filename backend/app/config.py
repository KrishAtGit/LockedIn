from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration, read from environment variables (or a .env file)."""

    # backend/.env, wherever the server is started from. A relative ".env" would be silently skipped when
    # starting from the repo root, falling back to a Postgres URL that doesn't exist locally.
    model_config = SettingsConfigDict(env_file=Path(__file__).resolve().parent.parent / ".env", env_prefix="LOCKEDIN_")

    database_url: str = "postgresql+asyncpg://lockedin:lockedin@localhost:5432/lockedin"

    # Set to false to run on built-in rules only, with no AI at all.
    ai_enabled: bool = True
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2:3b"
    # Local models can be slow on first load; past this, the request falls back to rules.
    ollama_timeout_seconds: float = 20.0


@lru_cache
def get_settings() -> Settings:
    return Settings()
