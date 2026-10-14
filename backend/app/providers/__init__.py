"""AI provider abstraction: real OpenAI or a deterministic mock (no key needed)."""
from ..config import get_runtime_settings
from .base import Provider
from .mock_provider import MockProvider
from .openai_provider import OpenAIProvider

_provider: Provider | None = None


def get_provider() -> Provider:
    global _provider
    if _provider is None:
        ai_provider = get_runtime_settings().ai_provider
        _provider = MockProvider() if ai_provider.lower() == "mock" else OpenAIProvider()
    return _provider
