"""
spanoai — Python SDK for SpanoAI: shared working memory (a context store) plus a
durable message bus for multi-agent AI systems.

    from spanoai import SpanoAI, AsyncSpanoAI, SpanoAIError
"""
from .client import AsyncSpanoAI, SpanoAI
from .errors import SpanoAIError
from .stream import StreamHandle

__all__ = ["SpanoAI", "AsyncSpanoAI", "SpanoAIError", "StreamHandle"]
__version__ = "0.1.0"
