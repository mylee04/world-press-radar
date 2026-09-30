# Public directory readiness

Updated September 30, 2026. **Draft uploaded; not submitted, approved or publicly listed.**

## Completed

- English portable package `plugin/`: manifest, public Streamable HTTP MCP configuration, one focused source-discovery skill and 96×96 SVG icon. No credentials, article datasets or server code in ZIP.
- Verified individual identity in **mylee**; uploaded preview developer **Myungeun Lee**. Approved public support **myungeun2dc@gmail.com**.
- Four approved HTTPS pages published at [website](https://news.bymyleslee.com), [support](https://news.bymyleslee.com/support), [privacy](https://news.bymyleslee.com/privacy) and [terms](https://news.bymyleslee.com/terms).
- Exact OpenAI ownership token published as plain text at the requested well-known path. Platform reports **Domain verified**, **MCP Configured**, no authentication, all four tools discovered and **No issues found in the latest MCP scan**. Challenge preserved by every bundle preparation.
- Skill scan **Checks passed**. Five positive and three negative review cases imported, complete.
- TypeScript build/typecheck and 34 tests passed, including metrics concurrency/durability, health fallback regression and bounded status history. Real HTTPS SDK and legacy initialize/list/call remained successful after page/domain deployments; cached audit time and output counts matched local data.

[Platform evidence](PLATFORM-EVIDENCE.json), [HTTPS page hashes](PAGES-VERIFICATION.json), [post-domain MCP evidence](post-domain-mcp-check.json). The full registry audit is recorded separately; these transport tests do not establish healthy publishers.

## Remaining

| Item | Evidence / next action |
| --- | --- |
| Metadata category | **Productivity** is a documented valid title and shown in the preview. Scan warning: “We couldn’t confirm the selected category. Review the category and make sure the listing clearly explains the plugin’s main purpose.” The portal exposes no selector. Keep the warning disclosed; automated findings other than required setup/validation errors may be considered by the reviewer. |
| Real client test cases | All five positive and three negative cases observed through the real personal no-auth MCP connection; Chile case rerun successfully after fixing a fallback bug. See REVIEW-TESTS.json. This is MCP testing, not proof that the complete packaged skill is installed. |
| Demo URL | Required `extensions.com.openai.review.demo_recording_url` missing. Local 108-second edited walkthrough of genuine, privacy-cropped ChatGPT captures is prepared. It is explicitly not continuous recording. Obtain content/public-hosting approval, then add URL and upload a new ZIP. No recording published yet. |
| Attestations/final submission | **Not approved/performed.** Show exact required portal attestations before accepting and submitting. Directory publication is a later separate action after review approval. |

No new costs, GitHub push, public repository, paid API, account-wide token, article retrieval, or source expansion is part of this submission phase. Metrics activation and its privacy notice are documented separately in `metrics/README.md`; no claim of historical usage is made.

## Local archive validation

```sh
npm run plugin:package
npm run plugin:validate -- --submission-ready
```

The first command validates vendored Agent Plugins 1.0.0 schemas, documented metadata limits, exact five-file whitelist and deterministic ZIP integrity, producing `publication/dist/world-news-sources-0.1.0-draft.zip`. The second intentionally exits **2** while video/final-approval gates remain. Local checks cannot replace Platform scans or review. `VALIDATION.json` records actual confirmed gates separately from remaining ones.

## References

[Submission requirements](https://developers.openai.com/plugins/deploy/submission), [testing guide](https://developers.openai.com/plugins/deploy/connect-chatgpt), [package layout](https://developers.openai.com/plugins/build/plugins), [guidelines](https://developers.openai.com/plugins/plugin-guidelines).
