-- 017_mcp_connectors.sql — allow many organization-owned MCP connectors.
--
-- `kind` remains the per-row unique discriminator used by existing
-- integrations. `provider` groups every MCP connector together while the
-- connector slug lives in config.key (and is repeated in kind for uniqueness).

alter table org_integrations
  add column if not exists provider text;

update org_integrations
set provider = kind
where provider is null;

-- Preserve Wave 17 Every grants while moving their flat token fields into the
-- connector model. The endpoint continues to come from EVERY_MCP_URL at runtime.
update org_integrations
set
  provider = 'mcp_connector',
  kind = 'mcp_connector:every',
  config = jsonb_strip_nulls(
    jsonb_build_object(
      'key', 'every',
      'name', 'Every',
      'url', coalesce(config->>'url', ''),
      'auth_kind', 'oauth',
      'status', case when nullif(config->>'access_token', '') is null then 'disconnected' else 'connected' end,
      'connected_at', config->'connected_at',
      'last_error', config->'last_error',
      'tokens', jsonb_strip_nulls(
        jsonb_build_object(
          'access_token', config->'access_token',
          'refresh_token', config->'refresh_token',
          'expires_at', config->'expires_at',
          'token_endpoint', config->'token_endpoint',
          'client_id', config->'client_id',
          'client_secret', config->'client_secret'
        )
      )
    )
  )
where kind = 'every_mcp';

alter table org_integrations
  alter column provider set not null;

create index if not exists idx_org_integrations_org_provider
  on org_integrations(org_id, provider);
