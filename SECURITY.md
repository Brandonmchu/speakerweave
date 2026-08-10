# Security Policy

## Supported versions

Security fixes are made against the latest commit on `main`. Older commits, forks, and downstream deployments are not separately supported.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Report it privately with this repository's [GitHub Security Advisory form](https://github.com/Brandonmchu/speakerweave/security/advisories/new). Include affected paths or endpoints, reproduction steps, impact, and any suggested mitigation. The maintainers will acknowledge the report, investigate it, and coordinate disclosure and a fix with you.

## Organization isolation

SpeakerWeave's API uses a Supabase service-role client that bypasses row-level security, so application-level organization scoping is a primary security boundary and database RLS is a backstop. Every organization-owned query must include `org_id`; path-addressed records follow fetch-with-`id`-and-`org_id`, verify ownership, then return an indistinguishable 404 for missing and foreign records. Any suspected cross-organization read or write should be treated as a high-priority security issue.
