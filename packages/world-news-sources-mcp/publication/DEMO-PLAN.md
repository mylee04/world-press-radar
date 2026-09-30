# Real client review walkthrough

Destination under consideration: a small static MP4 on the existing news Vercel Hobby project, with an HTTPS reviewer URL. Entire CLI source upload must remain below the documented 100 MB Hobby limit. Playback uses normal free project bandwidth; no Stream, paid storage, add-on or upgrade. **Do not publish until the recording content is approved.**

The authorized personal no-auth MCP connection is installed in ChatGPT. This tests the actual remote tools, not public directory installation or the complete packaged skill. A fresh chat contains public publisher metadata only; unrelated private chats and account panels are excluded from captures. No API Playground or paid API key is used.

Capture the five positive and three negative prompts from `plugin.json`, in order:

1. Five US enabled RSS source URLs; enabled is not health.
2. Five Croatia sitemap URLs; no article-search claim.
3. Texas Tribune details: sitemap blocked, RSS absent; keep endpoint outcomes independent.
4. First and next ten country sections; counts/order do not imply live coverage.
5. Chile RSS output: actual check time, 15 items and sample URLs; publication timestamp separate.
6. Full article request: scope/copyright-safe fallback, no fabricated article text. ChatGPT may use its own web search; distinguish that from MCP capability.
7. Delete disabled records: read-only explanation, no mutation claim.
8. Instant full live crawl/CAPTCHA bypass: no bypass or certification, explain cached state.

Save real screenshots as observed. An edited video made from these captures must be labeled as an edited capture walkthrough, not continuous screen recording; no fabricated UI, messages or results. Review every frame for account information and readable scope/date/status labels before public hosting. Save the exact observable results and limitations in `REVIEW-TESTS.json`. The UI may show “Interacted with World News Sources” without exposing exact internal tool names; do not invent a raw tool trace.

The first Chile case exposed a health-field fallback bug; null current reason incorrectly inherited a historical warning. Regression fix separates fields by selected observation presence and prevents old HTTP codes leaking into current failures. Re-run after deploying the fix; do not include the incorrect interpretation as a passing demo.

References: [official testing](https://developers.openai.com/plugins/deploy/connect-chatgpt), [review video requirement](https://developers.openai.com/plugins/deploy/submission), [Vercel upload limits](https://vercel.com/docs/limits).
