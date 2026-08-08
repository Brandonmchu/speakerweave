"""Liveness probe. Railway's healthcheckPath points here."""

from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
async def health():
    return {"status": "ok", "service": "dais-api"}
