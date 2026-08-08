import os

import httpx
from dotenv import load_dotenv
from supabase import Client, create_client
from supabase.lib.client_options import SyncClientOptions

# Load environment variables from .env file
load_dotenv()

supabase_url = os.getenv("SUPABASE_URL")
supabase_service_key = os.getenv("SUPABASE_SERVICE_API_KEY")

if not supabase_url or not supabase_service_key:
    raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_API_KEY must be set in .env file")

# Custom httpx client tuned for Supabase under concurrent load.
#
# Two recurring issues this config addresses:
#  1. `httpx.ReadError: [Errno 35] Resource temporarily unavailable` —
#     keepalive connections that the OS silently closed get reused, then
#     EAGAIN on first read. Fix: short keepalive_expiry, and
#     max_keepalive_connections must be <= max_connections (a previous
#     200 vs 100 was invalid and worsened the problem).
#  2. HTTP/2 stream stalls — a single stuck stream takes out the whole
#     multiplexed connection. Disabling http2 trades a small perf hit for
#     far more reliable per-request behavior in dev and Railway alike.
_pool_limits = httpx.Limits(
    max_connections=100,
    max_keepalive_connections=20,
    keepalive_expiry=5.0,
)
_httpx_client = httpx.Client(
    limits=_pool_limits,
    timeout=httpx.Timeout(30.0, connect=10.0),
    http2=False,
)

# Service-role key: this client BYPASSES RLS. Every query must carry its own
# org_id / event_id predicate — see auth.verify_org_access.
supabase: Client = create_client(
    supabase_url,
    supabase_service_key,
    options=SyncClientOptions(httpx_client=_httpx_client),
)
