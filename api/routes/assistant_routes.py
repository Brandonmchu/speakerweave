"""Authenticated in-app chat boundary for the shared conference assistant."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from auth import get_current_user_or_api_org
from security.rate_limiting import RATE_PUBLIC_WRITE, limiter
from services import assistant

router = APIRouter(prefix="/api/assistant", tags=["assistant"])

MAX_MESSAGES = 30
MAX_MESSAGE_CHARS = 8_000
MAX_HISTORY_CHARS = 32_000


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1, max_length=MAX_MESSAGE_CHARS)

    @field_validator("content")
    @classmethod
    def content_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Message content cannot be blank")
        return value


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[ChatMessage] = Field(..., min_length=1, max_length=MAX_MESSAGES)

    @model_validator(mode="after")
    def history_must_be_reasonably_sized(self):
        if sum(len(message.content) for message in self.messages) > MAX_HISTORY_CHARS:
            raise ValueError(f"Chat history cannot exceed {MAX_HISTORY_CHARS} characters")
        return self


class ToolCallAudit(BaseModel):
    name: str
    summary: str


class ChatResponse(BaseModel):
    reply: str
    tool_calls: list[ToolCallAudit]


@router.post("/chat", response_model=ChatResponse)
@limiter.limit(RATE_PUBLIC_WRITE)
async def chat(
    request: Request,
    payload: ChatRequest,
    auth: tuple = Depends(get_current_user_or_api_org),
) -> ChatResponse:
    _user_id, org_id = auth
    result = await assistant.run(
        [message.model_dump() for message in payload.messages],
        org_id,
    )
    return ChatResponse(
        reply=result.reply,
        tool_calls=[ToolCallAudit(**tool_call) for tool_call in result.tool_calls],
    )
