---
name: express-review
description: Reviews Express.js route handlers for common issues. Use when reviewing routes, checking API endpoints, or auditing Express code.
---

When reviewing Express route handlers:

1. Read the route file being reviewed
2. Check each endpoint for these issues:
   - Missing input validation on req.body and req.params
   - Missing error responses (404 for not found, 400 for bad input)
   - Inconsistent response status codes
   - Missing null/undefined checks before accessing properties
3. Format findings as a checklist with file:line references
