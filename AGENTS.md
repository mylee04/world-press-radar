# Repository agent instructions

## Writing and Git preferences

- Never use Unicode U+2014 in assistant-authored chat, documents, UI text, code comments, commit messages, issues, pull requests or other writing. Use sentences, commas, colons or parentheses instead.
- Keep each GitHub prose paragraph on one source line. Use line breaks between paragraphs and for Markdown structures only.
- Before creating or renaming any local or remote Git branch, propose its exact complete name and wait for the user's explicit approval. Do not add an automatic prefix without that approval.

## Work efficiency

- Prioritize concrete user-visible results and conserve time and tokens. Avoid repeated full test suites, redundant review loops, elaborate proof packages and frequent tiny deployments.
- Use the minimum targeted verification appropriate to the change. Reuse completed checks. Broaden checks only for a meaningful behavior change, an actual failure or an explicit requirement.
- Batch data collection and deployment. Prefer existing workflows. Delegate when it saves time or improves the result.
- Keep updates concise and distinguish prepared research from results verified on the live service.

## World News Sources operational usage

- All our own public MCP checks, demonstrations, debugging and source-pack download tests must be marked as inspection. Use `packages/world-news-sources-mcp/scripts/operator-mcp.mjs` or an existing tagged operational workflow. Preserve the `x-world-news-traffic: inspection` header.
- Do not use the managed published-plugin connector for these checks because it cannot attach the inspection header. Do not fall back to an unmarked request when a marked path fails. If only an untaggable path is available, stop that check and report the limitation. Correct known prior unmarked checks only from exact documented calls and dates.
- New operational checks must require `x-world-news-metrics: recorded` for successful and unsuccessful counted requests. Do not automatically retry a missing acknowledgment. Follow the bounded workflow in `packages/world-news-sources-mcp/ops/OPERATOR-USAGE.md`.
- Read usage from the existing aggregate store or reports. Do not generate MCP traffic to inspect usage. Remaining unclassified traffic is possible outside use and must never be reported as confirmed external users, satisfaction or a successful external reader connection.
- Preserve news collection history, excluded initial baselines and the distinction between first-discovered URL counts and published article counts. Do not start duplicate collections or broad audits for routine reporting.
