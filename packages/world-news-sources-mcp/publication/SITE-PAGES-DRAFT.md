# English site and policy drafts

**Local review draft; not published.** Intended destination: the independent `news.bymyleslee.com` project only. Publication date and verified developer identity must be filled in before launch. The approved public support email is **myungeun2dc@gmail.com**. The bracketed fields below are unresolved review items, not proposed public text.

## Homepage — `/`

# World News Sources

Find configured news publisher RSS feeds and sitemaps, and inspect their cached health.

Search sources by country, publisher name or domain, language, category and endpoint type. Browse supported countries, inspect source details, and read separate RSS and sitemap check results.

Health records include actual check times, parsed entry counts, sample URLs and publication freshness when dates are available. Checks are cached and can become stale. Some endpoints are empty, blocked, unavailable, malformed or incompletely checked. An enabled source is a configuration choice, not a guarantee of availability. Sitemap indexes describe child sitemap references; their child files and article links are not validated by this service.

The service provides read-only source metadata. Article search and full article text are outside its capabilities. Tool calls use the existing catalog and health cache rather than fetching publishers live. No account or API key is required.

MCP address: `https://news.bymyleslee.com/mcp`
[Service status](/health) · [Support](/support) · [Privacy](/privacy) · [Terms](/terms)

Developer: **[Verified public developer identity — not yet visible]**
Support: [myungeun2dc@gmail.com](mailto:myungeun2dc@gmail.com)

## Support — `/support`

# Support

For service issues, source corrections, privacy requests or questions, email [myungeun2dc@gmail.com](mailto:myungeun2dc@gmail.com).

For a source issue, include the publisher name, configured endpoint URL or ID, the recorded check time, and the issue you observed. For a connection issue, include your MCP client, the tool name, approximate time and error message. Please redact passwords, tokens, private conversation contents and personal information that is not needed to diagnose the issue.

Publisher websites and feeds are operated independently. Cached health is an observation at the recorded time; the service cannot guarantee publisher uptime, article access, update frequency or a response time for support.

Developer: **[Verified public developer identity — not yet visible]**

## Privacy — `/privacy`

# Privacy

Effective date: **[Date approved for publication]**
Operator: **[Verified public developer identity — not yet visible]**
Contact: [myungeun2dc@gmail.com](mailto:myungeun2dc@gmail.com)

### Information processed

When an MCP client calls the service, it sends a tool name and parameters, such as a country, publisher search term, language, category, pagination setting or source/endpoint ID. The service processes these parameters to return source metadata and cached health. It does not require an account, payment details or an API key. Please do not send sensitive personal information in tool parameters.

The current application has no user-query database and does not intentionally write request bodies or full conversations to application logs. It has no integrated advertising or analytics library and sets no custom tracking cookies. These statements describe the application code and do not imply that hosting creates no logs.

Vercel hosts the service and may process connection and operational information, including the calling client's IP address, request time, route, HTTP status, diagnostic information and request identifiers. A client such as ChatGPT may make requests from its own servers. Vercel's [privacy notice](https://vercel.com/legal/privacy-notice) and [runtime-log documentation](https://vercel.com/docs/logs/runtime) describe its processing and logging.

If you email support, the support mailbox receives your email address, message and any attachments you choose to send. Email is handled through Gmail and is subject to the email provider's processing.

### Purposes and recipients

Tool parameters are used to answer the requested metadata lookup. Hosting and diagnostic information support service delivery, security and troubleshooting. Support messages are used to respond to inquiries. Vercel and the email provider process information needed for those functions. Your MCP client handles its own conversation, account and connection data under its own policies; this service's notice does not replace those policies.

Publisher URLs are not fetched during tool calls. Operator checks of publicly configured feeds and sitemaps occur separately and do not receive your tool parameters or conversations. Following a returned publisher link creates a separate interaction governed by that publisher's policies.

### Retention and controls

The application does not persist a history of user tool queries. Hosting logs and diagnostic information follow the provider's applicable retention and settings. Vercel runtime-log visibility varies by plan; it is not a guarantee about all infrastructure data. **[Confirm actual project plan, logging integrations/drains and relevant retention before publication.]**

Support correspondence remains in the support mailbox until deleted. **[Approve an operational retention period or retention criteria before publication.]** You may email support to request access, correction or deletion of information held by the operator; applicable obligations and provider capabilities may affect what can be deleted. Disconnecting the plugin stops future use through that connection and does not automatically delete existing provider logs or support messages.

Material changes to this notice will be reflected on this page with an updated effective date.

## Terms — `/terms`

# Terms of Use

Effective date: **[Date approved for publication]**
Operator: **[Verified public developer identity — not yet visible]**

World News Sources supplies configured news source metadata and cached endpoint observations through read-only MCP tools. Its supported features are source discovery, source details, country listings and endpoint health. Article search, full article retrieval, publisher access bypasses and registry modifications are outside the service's capabilities.

Catalog records and health observations may contain errors or become outdated. A successful XML check establishes the recorded structural result at that time; it does not guarantee recent content, complete coverage, article availability or future uptime. Sitemap-index results concern listed child references and do not verify those child files. Use the returned check times and freshness fields when assessing a source.

Publishers retain control of their own sites, feeds and content. Listing an endpoint does not imply affiliation, endorsement or a grant of rights to publisher content. Respect applicable laws, publisher terms, access controls and usage limits when accessing or reusing material. Do not use this service to bypass authentication, CAPTCHA or other access restrictions, disrupt the service, or send unnecessary sensitive information.

The service may change or become temporarily unavailable. No availability or support-response guarantee is offered. These terms do not exclude rights that cannot lawfully be excluded. Your MCP client and any publisher you visit have their own terms.

For support or questions about these terms, contact [myungeun2dc@gmail.com](mailto:myungeun2dc@gmail.com). See the [Privacy notice](/privacy) for information processing.

## Facts and approval needed before publishing

1. Confirm the exact verified public developer identity; the Platform organization label **mylee** is not sufficient evidence of that name.
2. Confirm the actual Vercel plan, project logging/drains/integrations and applicable retention. Current documentation lists runtime-log visibility as one hour for Hobby, one day for Pro, and longer periods for certain plans/add-ons. Those values are not inserted as this service's retention guarantee.
3. Approve support-mailbox retention criteria and the privacy/terms wording. No new retention behavior is silently promised or implemented.
4. Fill the effective date and authorize publishing these four pages to the independent news project. The portfolio and other projects are outside this scope.

### Implementation evidence

Reviewed `src/server.ts`, `src/http.ts` and `scripts/prepare-vercel.mjs`: four read-only tools, stateless HTTP, no account authentication, no application query store or analytics integration, bundled registry/cache, no publisher fetch during calls. Source health observations and catalog snapshots are operator data and are separate from visitor request data. The deployed minimal homepage currently has no contact/policy pages; this artifact proposes their content without changing the live service.

Provider references checked September 30, 2026: [Vercel runtime logs](https://vercel.com/docs/logs/runtime), [Vercel privacy notice](https://vercel.com/legal/privacy-notice). Account-specific settings remain unconfirmed. This draft requires operator review before it becomes a public policy.
