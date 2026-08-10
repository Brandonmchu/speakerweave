## What changed?

Describe the problem, the solution, and any user-visible behavior.

## Verification

- [ ] Tests were added or updated for behavior changes
- [ ] API tests and Ruff are green
- [ ] Web TypeScript/build verification is green
- [ ] Web Vitest suite is green
- [ ] Every affected tenant query carries `org_id`, and by-ID access uses fetch → verify → 404
- [ ] New migrations are additive and new environment variables are documented, if applicable
