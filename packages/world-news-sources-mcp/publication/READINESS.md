# Public directory readiness

Prepared September 30, 2026. This is a local draft; it has not been uploaded, submitted, approved or published in the directory.

## Ready locally

Portable `plugin/` contains the English manifest, remote MCP configuration, one focused discovery/health skill and a 96×96 SVG draft icon. It points at the existing verified-live `https://news.bymyleslee.com/mcp`, requires no authentication, and bundles no credentials, server code or source datasets. Five positive and three negative reviewer scenarios are included. English copy: [LISTING-COPY.md](LISTING-COPY.md).

## Local validation and draft archive

From `packages/world-news-sources-mcp`, run:

```sh
npm ci --ignore-scripts
npm run plugin:validate
npm run plugin:package
npm run plugin:validate -- --submission-ready
```

The package command creates `publication/dist/world-news-sources-0.1.0-draft.zip` with `plugin.json` and `mcp.json` at the archive root. It validates the two vendored official schemas, checks the listing's documented limits and focused skill dependency, includes exactly five approved local files, and verifies archive contents against the source files. `publication/VALIDATION.json` records the file/archive hashes and unmet gates. The final command intentionally exits **2** while required package fields or external gates remain unresolved; normal structural validation exits **0**. External gates must be confirmed from Platform evidence before this draft can be described as submission-ready.

Validation on September 30, 2026: portable schemas and ZIP integrity passed; the skill-creator quick validator reported **Skill is valid**; TypeScript typecheck/build and **24 package tests passed**. The natural-language reviewer scenarios have not been executed in ChatGPT. The draft has not been uploaded.

## Remaining requirements and approvals

| Item | Current evidence | Next concrete step |
| --- | --- | --- |
| Verified publisher | Existing Platform session's organization settings shows Individual and Business **Start**, not completed verification | User chooses personal/business publisher identity and completes verification; directory name follows that verified identity |
| Submission permission | Authenticated Plugins dashboard shows **Upload new or existing plugin**; precise Apps Management permission not yet confirmed | Check organization owner role or `api.apps.write` before creating the draft |
| Publisher text | Not inserted into package | Approve public publisher name consistent with verified identity |
| Public support | No contact information inserted | Approve a public support address/channel and support-page content |
| Product website | Existing minimal endpoint landing page works, but publisher identification is not yet approved | Approve English product/support/policy content and adding pages only to the independent news project |
| Privacy and terms | Required URLs deliberately omitted; no fake or unapproved policy URLs | Confirm publisher, support contact, hosting log retention/processing and policy wording; then authorize publishing dedicated pages |
| Icon/category | Draft SVG included; Productivity proposed | Approve asset and confirm available dashboard category |
| Domain ownership | HTTPS works; OpenAI challenge has not been obtained | After an authorized draft upload, host the exact portal token at its displayed `/.well-known/openai-apps-challenge` URL; approve that targeted server change |
| Review scenarios | Tool-level automated tests exist; five positive and three negative natural-language scenarios drafted | Run the scenarios in ChatGPT with the installed draft and record observations; local tests cannot prove routing/refusal behavior |
| Demo | No recording created or published | Record the approved test walkthrough and approve its reviewer-accessible hosting destination |
| Attestations/submission/publication | None accepted or performed | Review exact portal attestations and obtain explicit authorization at those steps |

Observed verification screen: https://platform.openai.com/settings/organization/general (in the user's currently selected organization). It states: “Verify as an individual or business to access protected models and submit ChatGPT apps.” Individual says “You are verifying as a solo developer.” Business says “You are verifying a registered company.” **Start was not clicked.** Document/provider requirements are not visible before starting, so this report makes no claim about them. No identity documents were accessed. This draft contains no private contact details or account identifiers. The observed dashboard is https://platform.openai.com/plugins.

The package omits `author`/`developerName` and missing review URLs rather than pretending the draft is submission-ready. The portable schema permits a draft without these fields; OpenAI's submission gate requires the completed publisher and listing fields. Run the readiness validator again after adding approved fields. Local structural validation does not replace OpenAI scans or review.

## Approval content to prepare next

Publish only within `news.bymyleslee.com`, after approval:

- `/`: English product description, scope, publisher identity and links to support/privacy/terms.
- `/support`: approved public support channel, issue-reporting instructions, no feed-uptime guarantee.
- `/privacy`: accurate request/query handling, recipients (OpenAI/hosting provider as applicable), retention, user controls/contact. Application tools do not persist user searches; hosting can process request metadata. Confirm actual provider logging/retention before asserting durations or “no data collection.”
- `/terms`: metadata-only service, cached and fallible observations, independent third-party publishers and their own access conditions, no publisher affiliation/endorsement, no article-access grant, public support contact and approved service terms.

Do not put review credentials or internal operational files into the ZIP. No account is required here, so dedicated reviewer credentials are unnecessary. Omit publication country targeting until the user chooses availability; configured source countries are not a directory availability allowlist.

## Authoritative references

- [OpenAI packaging](https://developers.openai.com/plugins/build/plugins): portable layout and MCP transport declaration.
- [OpenAI submission](https://developers.openai.com/plugins/deploy/submission): identity, listing metadata, domain challenge, review scenarios and demo.
- [MCP review requirements](https://developers.openai.com/plugins/deploy/app-review): remote endpoint and organization permission requirements.
- [Plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines): accurate capabilities, authorized third-party access and privacy disclosure.

The user must assess permission to publish source metadata and the operator's ongoing endpoint-check practices against applicable publisher access conditions before making policy attestations. This report records actual failures and does not establish universal third-party approval. No additional crawl was run for this packaging phase.
