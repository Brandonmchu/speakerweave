"""Security middleware."""

from __future__ import annotations

from typing import ClassVar

from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send


class SecurityHeadersMiddleware:
    """ASGI middleware to enforce baseline security headers and block unsafe methods."""

    BLOCKED_METHODS: ClassVar[set[str]] = {"TRACE", "TRACK", "CONNECT"}
    ALLOWED_METHODS: ClassVar[set[str]] = {
        "GET",
        "HEAD",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
    }

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope["method"]
        if method in self.BLOCKED_METHODS or method not in self.ALLOWED_METHODS:
            response = JSONResponse(
                status_code=405,
                content={"detail": f"Method {method} not allowed"},
                headers=self._get_security_headers(),
            )
            await response(scope, receive, send)
            return

        async def send_with_headers(message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                for header, value in self._get_security_headers().items():
                    headers.append((header.encode(), value.encode()))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_with_headers)

    def _get_security_headers(self) -> dict[str, str]:
        return {
            "X-Frame-Options": "SAMEORIGIN",
            "Content-Security-Policy": "frame-ancestors 'self'",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
            "Permissions-Policy": (
                "geolocation=(), microphone=(), camera=(), payment=(), usb=(), "
                "magnetometer=(), accelerometer=(), gyroscope=()"
            ),
        }
