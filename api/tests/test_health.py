"""App boots, /health answers, and the middleware stack is wired."""


def test_health_ok(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "dais-api"}


def test_security_headers_present(client):
    headers = client.get("/health").headers
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["X-Frame-Options"] == "SAMEORIGIN"
    assert "frame-ancestors" in headers["Content-Security-Policy"]


def test_trace_method_blocked(client):
    assert client.request("TRACE", "/health").status_code == 405


def test_cors_preflight_allows_authorization_header(client):
    """Guards the trap: a header missing from _CORS_ALLOW_HEADERS 400s the
    entire preflight, not just that header."""
    response = client.options(
        "/api/events",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_cors_rejects_unknown_origin(client):
    response = client.options(
        "/api/events",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert "access-control-allow-origin" not in response.headers
