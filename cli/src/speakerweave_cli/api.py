"""Small synchronous HTTP client for SpeakerWeave's token-authenticated API."""

from __future__ import annotations

from typing import Any

import httpx


class ApiError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class ApiClient:
    def __init__(self, server: str, token: str, *, timeout: float = 30.0):
        self.server = server.rstrip("/")
        self._client = httpx.Client(
            base_url=f"{self.server}/",
            headers={
                "accept": "application/json",
                "user-agent": "speakerweave-cli/0.1.0",
                "x-access-token": token,
            },
            follow_redirects=True,
            timeout=timeout,
        )

    def close(self) -> None:
        self._client.close()

    def request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = self._client.request(method, path.lstrip("/"), **kwargs)
        except httpx.TimeoutException as exc:
            raise ApiError(f"Request to {self.server} timed out.") from exc
        except httpx.RequestError as exc:
            raise ApiError(f"Could not reach {self.server}: {exc}") from exc
        if response.is_error:
            raise self._error(response)
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise ApiError(
                f"Server returned an invalid response ({response.status_code}).",
                status_code=response.status_code,
            ) from exc

    def get(self, path: str, *, params: dict[str, Any] | None = None) -> Any:
        return self.request("GET", path, params=params)

    def post(self, path: str, *, json: Any = None) -> Any:
        return self.request("POST", path, json=json)

    def patch(self, path: str, *, json: Any) -> Any:
        return self.request("PATCH", path, json=json)

    def get_all(self, path: str, *, params: dict[str, Any] | None = None) -> list[dict]:
        query = dict(params or {})
        query["pageSize"] = 100
        page = 1
        collected: list[dict] = []
        while True:
            query["page"] = page
            payload = self.get(path, params=query)
            if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
                raise ApiError("Server returned an unexpected list response.")
            batch = payload["data"]
            collected.extend(item for item in batch if isinstance(item, dict))
            total = payload.get("total")
            if not batch or not isinstance(total, int) or len(collected) >= total:
                return collected
            page += 1

    def verify(self) -> None:
        self.get("/v1/events", params={"page": 1, "pageSize": 1})

    @staticmethod
    def _error(response: httpx.Response) -> ApiError:
        status = response.status_code
        if status == 401:
            return ApiError(
                "Authentication failed. Check your API token or run 'sw auth login'.",
                status_code=status,
            )
        detail: Any = None
        try:
            payload = response.json()
            if isinstance(payload, dict):
                detail = payload.get("detail") or payload.get("message") or payload.get("error")
        except ValueError:
            pass
        if isinstance(detail, list):
            messages = []
            for item in detail:
                if isinstance(item, dict):
                    messages.append(str(item.get("msg") or item))
                else:
                    messages.append(str(item))
            detail = "; ".join(messages)
        message = str(detail).strip() if detail else f"Server returned HTTP {status}."
        return ApiError(message, status_code=status)
