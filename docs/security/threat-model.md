# Threat model

Written at the architecture gate, 23 Sep 2026, from `docs/security/system-description.md` only. No code exists yet. Section C is the definition of done for the backend: every work order carries its invariants, and a cook's report must point to the file and function that upholds each one.

## A) App-class risk profile

In security terms this is four things at once:

1. **A credential-relaying API proxy.** The browser hands the server a third party's secret (the team's SERV key) and the server uses it to make paid calls to `inference-api.openserv.ai` on the caller's behalf (flow 4).
2. **A metered spender of the operator's money for anonymous callers.** Demo runs put the operator's SERV key behind an unauthenticated endpoint, guarded only by a daily budget counter in Postgres (flows 4 and 5, "Who pays for what").
3. **An unauthenticated multi-tenant data store with capability-URL access.** Anyone can create workloads and runs (flows 2 and 3); anyone holding an id can read them (flows 6 and 7). There are no accounts, so the id is the only access control.
4. **A renderer and parser of user-controlled structured content.** The server parses user JSON, CSV and JSON Schema, compiles the schema and runs it against model output, applies user-defined scoring rules, runs text inspection over user prompts (flow 1), and the report page renders prompts, case inputs, expected answers, model answers and rewritten prompts back to browsers (flow 6).

Vulnerability categories that typically bite this class, tied to this system:

- **Secret leakage of the relayed credential.** The team key arrives in a request header on every per-case call. The places it can leak: Vercel function logs (request logging, error stack traces that include headers or the outbound request object), the Postgres row for the result if the outbound request is stored for debugging, an error message from SERV echoed back to the browser, and the browser side if it is kept in `localStorage`. Applies directly: the description says the key "is not meant to be stored anywhere", which is an intent, not yet a property.
- **Payer confusion.** Flow 4 decides who pays by whether a header is present on each individual case call. A run created for a custom workload with a team key can then be driven with the header omitted, or with an empty header, and the server falls through to the operator key. Applies directly: the payer decision is made per request against a mutable signal, not bound to the run.
- **Race and replay against a budget counter.** The browser calls flow 4 "a few at a time" and loops. If the budget check is read-then-write, N concurrent calls each see budget remaining and all spend. If `(run, case, config)` can be called twice, each call spends again. Applies directly: the counter lives in Postgres and the calls are concurrent by design.
- **Unintended billable upstream call.** Flow 5 assumes the oversized balance probe always fails with 402. If a key has enough credit for the "oversized" request, or SERV changes what it rejects, the probe becomes a real, large, paid inference. Applies directly, and to the operator key too. (This happened on 25 Sep: SERV began running the probe. C7 caught it and stopped the demo, and the probe was removed; see C7.)
- **Insecure direct object reference and id guessing.** Workload ids, run ids, case ids and report ids are the whole access model. Sequential or short ids let a stranger read every team's system prompt and expected answers (which are often the team's private evaluation set). Applies directly.
- **Capability confusion between report id and run id.** A share link (flow 7) is meant to expose a report. If the report page or its data fetch uses the run id, or the run id is derivable from the report id, a report reader can also call flow 4 and drive spending, or read the run's raw workload. Applies directly.
- **Stored cross-site scripting.** The report renders text that three parties control: the team (prompt, cases, expected values), the model (answers, which any test case content can steer via prompt injection), and the lint rewrite. Applies directly to flow 6 and the report page.
- **Parser abuse: JSON Schema, regex and CSV.** JSON Schema `pattern`, `patternProperties` and `format` are attacker-supplied regular expressions run on the server against model output (catastrophic backtracking). `$ref` can point at a URL and some validators will fetch it. Deep or huge schemas blow the compile step. The lint in flow 1 runs server-side text inspection over an attacker-supplied prompt, which is the same regex risk in a different endpoint. CSV parsing on uploads has size and quoting edge cases. All apply directly.
- **Mismatched comparison in scoring.** Expected values are stored from JSON or CSV (strings), model answers arrive as JSON from SERV (numbers, strings, booleans). Exact match and numeric tolerance compare values that went through different parsers. This is a correctness bug that also lets a crafted workload make any configuration "win". Applies directly to flow 4 scoring.
- **Untrusted upstream responses.** The SERV 200 body, its error bodies (including the 402 text the balance parser reads), its headers, and the model list endpoint (flow 1) are all inputs the server acts on: it stores tokens, latency, finish reason, request id and answer text, and it marks model ids as retired. Applies directly.
- **Resource exhaustion on free-tier limits.** Free Postgres storage, Vercel function count and duration, and the daily demo budget are all finite and all reachable without authentication. A bot that fills the workload table or spends the demo budget at midnight takes the demo down before a judge arrives. Applies directly.
- **Data leaving under the wrong retention terms.** Requests sent with the operator key may be retained by OpenServ under the hackathon data-collection rule. If any team-supplied text ever travels with the operator key, the product has silently placed a third party's data under terms they did not accept. Applies directly to demo mode.

Categories that do not apply, and why:

- **Server-side request forgery via user URLs.** The upstream host is fixed in code and no endpoint accepts a URL. It does not apply today. It becomes live the moment a base URL, a schema `$ref` fetch, or an "import from URL" is added, so C12 and C22 pin it down.
- **SQL injection.** Applies only in the generic sense; all queries go through a parameterised client. Listed as a table stake, not a modelled risk.
- **Authentication and session attacks.** There are no accounts, passwords or sessions. The equivalent risk is id guessing, covered above.
- **Filesystem and command execution.** No user value reaches a path or a shell. Serverless functions have no persistent disk. Does not apply.

## B) Threat model

### Trust boundaries

1. Browser to server, on every endpoint: bodies, headers, path parameters, query strings. Nothing on this side is trusted, including the team key header (it may be empty, malformed, or somebody else's).
2. Server to SERV Reasoning API and the model list endpoint: the outbound request is trusted content built by the server; the response is untrusted.
3. Server to Postgres: values written earlier were user-supplied and stay untrusted when read back (prompts, schemas, cases, expected values, answers, share flags).
4. Server to browser on the report page and run status: everything rendered was supplied by a team, a model, or a stranger with the workload endpoint.
5. Server environment: operator key and database URL cross from trusted config into request handling; the boundary is which handlers may read them.
6. Time: the daily budget window depends on the server clock and time zone, which the code chooses, not the caller, but must be chosen once.

### Attacker-controlled inputs

Direct:
- `POST /api/lint`: system prompt text, sample user message, their lengths and encodings, any model id mentioned inside them.
- `POST /api/workloads`: system prompt, JSON schema (every keyword: `pattern`, `format`, `$ref`, `$id`, `definitions`, nesting depth, `additionalProperties`), case count, per-case input, expected values, scoring rule per field, tolerance numbers, one-of lists, CSV cells and header row, uploaded file name if the server ever sees it, total body size.
- `POST /api/runs`: workload id (may be another tenant's or nonexistent), configuration list (length, model ids, SERV modes, duplicates), any per-run options such as token caps or streaming flags.
- `POST /api/runs/:id/cases/:caseId`: run id, case id (may belong to a different run), configuration index, the team key header (present, absent, empty, whitespace, a different team's key), concurrency and repetition of the call, timing relative to the budget window.
- `GET /api/runs/:id`, `GET /r/:reportId`, `POST /api/reports/:runId/share`: the ids, and the caller's ability to enumerate them.
- Transport headers: `Content-Type`, `Content-Length`, `Origin`, `X-Forwarded-For` if used for rate limits.

Indirect:
- SERV 200 response: `choices[].message.content` (answer text, may be non-JSON, huge, or contain HTML and script), `usage` fields (may be missing, negative, or strings), `finish_reason`, request id header, response size, response time.
- SERV error responses: status codes other than 402 for the probe, the 402 body format that the balance parser reads, error text that may quote request content.
- Model list response: model ids and status flags; an outage or a schema change is an input too.
- Values read back from Postgres: a stored schema compiled a second time at scoring, expected values, the share flag, the budget counter and its date.
- The model's own output as steered by case content (prompt injection): it becomes stored answer text and rendered report content.
- The date and time zone the budget rolls over on.

### Privileged position and assets

- The operator's SERV key and the credit behind it. A stranger cannot spend it directly; this server can, on every demo case call.
- Every team's SERV key, transiently, on every case call. A stranger cannot see it; the server holds it in memory and can log, store or forward it.
- The database URL and the whole multi-tenant store: every workload, expected answer set, model answer and report, across all teams.
- Outbound network from Vercel: the ability to send arbitrary content to OpenServ under the operator's organisation, where it may be retained.
- The report domain: the ability to serve HTML under the product's origin to anyone with a link, which is where a stored script would run.

### Attacker goals (highest value first)

1. **Drain the operator's SERV credit.** Enabled by flow 4 in demo mode: omit the key header on a custom-workload run, race the budget counter with parallel calls, replay the same `(run, case, config)`, pick the most expensive model and the `full` mode, or trigger the flow 5 probe repeatedly. Also by a probe that unexpectedly executes.
2. **Steal a team's SERV key.** Enabled by the header on flow 4 reaching logs, stored rows, or error responses; by a stored script on the report page (goal 4) reading it from browser storage; by a permissive CORS policy letting a hostile page send it.
3. **Read another team's workload and results.** Enabled by guessable ids on flows 2, 3, 6 and 7, by a report id that also opens the run API, or by `POST /api/reports/:runId/share` being callable by anyone who has seen a run id.
4. **Run script in other visitors' browsers under the product origin.** Enabled by the report page rendering prompts, case inputs, expected values, model answers or lint rewrites as HTML or unsanitised markdown. The model answer is the easiest vector: a test case that asks the model to reply with a script tag.
5. **Take the demo down while judges are looking.** Enabled by unauthenticated writes filling free Postgres, by ReDoS in the lint regexes or a schema `pattern`, by oversized bodies or answers, by spending the daily demo budget with a script the moment it resets, or by holding many 120-second functions open.

## C) Defensive-programming standards (the definition of done)

Each invariant is an outcome the code must uphold. A cook's report names the file and function that upholds it, and the test that shows it holding.

### Keys and payer

- **C1. A team key exists only in memory for the duration of one case call.** It is never written to Postgres, never appears in any log line, error message, stack trace, response body or report, and is never accepted in a URL or query string. Test: run a case with a canary key, then grep the database dump, the function logs and every response for the canary.
- **C2. The only network destination that ever receives any SERV key is the fixed `inference-api.openserv.ai` host over TLS.** No configuration value, header, schema field or stored value can change that host.
- **C3. The payer is fixed when the run is created and cannot change afterwards.** A run is either `team` mode or `demo` mode. A case call whose key presence disagrees with the run's mode is rejected: a demo run with a key header, or a team run without one, both fail. An empty or whitespace header counts as absent.
- **C4. No user-supplied text ever travels with the operator key.** Demo runs can only reference sample workloads created by the operator, using only operator-fixed model ids and SERV modes. Test: create a workload through the public endpoint, create a run for it with no key, and confirm the run is rejected at creation, not at the first case call. (Amended 26 Sep: a demo call re-checks its setting against the sample's allowlist at call time, not only when the run is created.)
- **C5. Operator credit is spent at most once per `(run, case, configuration)`.** A repeated call returns the stored result without an outbound request. Test: fire the same case call ten times concurrently and confirm exactly one SERV request id is recorded. (Amended 24 Sep: on a team run, a call SERV answers with 401, which SERV documents as a missing or invalid key and so bills to no account, is released instead of stored, so the owner can run it again with a corrected key. Every other status, 403 included, is stored as before. Demo calls are never released. Amended again after the final review: a team call SERV refuses with 402 insufficient_credits, which SERV decides before any model runs (the same property C7 relies on), is released the same way so the run resumes after a top-up. Both releases count against C33.) (Amended 26 Sep: a call that never reached SERV, because the connection failed, or that SERV answered with 429, is released rather than stored, on team and demo runs alike, and a demo call's reservation settles at 0, because SERV billed nothing. The browser pauses a run after three such failures or stored upstream errors in a row.) (Amended again 26 Sep, review pass 2: a claim is only treated as dead after 310 seconds, longer than the route's 300-second limit, because a stalled database could otherwise let a retry take over a live claim and bill the team twice; a failed save of a paid answer is retried once.)
- **C6. The daily demo budget cannot be exceeded by concurrent calls.** Budget is reserved with a single atomic conditional write before the outbound request and reconciled after it; if the reservation fails, no request is sent. If the counter cannot be read or written, the call is denied. The window boundary uses one fixed time zone chosen in code. (Amended 26 Sep: each address also has an hourly bucket of demo calls, so one visitor cannot drain the day. The daily cap stays the only money limit.)
- **C7. Urai never reads a balance by sending a request.** (Rewritten 25 Sep.) Until 24 Sep, a request SERV had to refuse with a 402 revealed a key's balance for free. On 25 Sep SERV ran that same request as a billed call instead; the original C7 guard caught the 200, set the global stop and halted the demo, as designed. The probe was then removed. Urai now sends SERV only case calls and the model list read, and every cost it shows comes from SERV's token counts (C28). Reports from before 25 Sep keep the balance readings taken then; the current sample reports, re-run on 26 Sep with each agent sent exactly as written, carry none.

### Access to stored data

- **C8. Every public identifier (workload, run, report) is generated server-side from a cryptographically secure source with at least 128 bits of entropy.** No sequential or time-derived id is ever exposed. Holding one id grants nothing about any other.
- **C9. A report id and a run id are independent secrets.** Knowing a report id does not let anyone call the run API, the case endpoint, or the share endpoint, and does not reveal the workload id or the run id. The report page fetches by report id only.
- **C10. A case id is valid only inside its own run.** A case call with a case id from a different run, or a configuration index outside the run's list, is rejected before any budget or key logic runs.
- **C11. Sharing requires proof that a report-link holder does not have.** Run creation returns a one-time owner token, and only that token can make the report public. A report is private by default.

### Parsing and evaluation

- **C12. Schema compilation is closed: no remote `$ref`, no `$ref` outside the submitted document, no custom keywords, a fixed maximum schema size and nesting depth, and a fixed compile time cap.** A schema that trips any of these is rejected at workload creation, and the same compiled schema (same library, same options, same version) is used at scoring time.
- **C13. No attacker-supplied regular expression, and no server-side regex run over attacker text, can take more than a bounded time.** Schema `pattern` and `patternProperties` run under a linear-time engine or a hard timeout that rejects the case; lint regexes are reviewed for backtracking and run against a length-capped input. Test: a `(a+)+$` pattern against a 50 KB answer returns an error within the cap.
- **C14. Every request body, upload, case count, per-case text, schema, answer text and upstream response has an explicit size cap, and every upstream call has an explicit timeout below the function limit.** Anything over the cap is rejected with no partial processing.
- **C15. Scoring compares two values produced by the same normaliser.** Expected values and model answers are both coerced by one function per scoring rule (numeric parse for tolerance, one Unicode normalisation and trim policy for exact match, the same for one-of membership), and a value that fails to normalise scores as a miss, never as a match. (Amended 26 Sep, review pass 3: a number rule allows only floating-point error beyond its tolerance, never a slack that grows with the value; review pass 1's fix had let a unit off at a billion score right, and pass 3 caught it.)
- **C16. Model answers are treated as data, never as instructions or markup.** A non-JSON answer, an answer that fails the schema, or an answer that is too large is stored as a failed case with its text kept as an opaque string.

### Upstream responses

- **C17. Every field taken from a SERV response is validated before it is stored or shown.** Token counts are non-negative integers or null, finish reason is a bounded string, request id is a bounded string, answer text is capped. A response that fails validation is recorded as an upstream error, and the case is not scored.
- **C18. A model list failure never invents a finding.** If the list endpoint is down or malformed, the lint reports "could not verify" for model ids rather than "unknown" or "valid", and the cached list has a bounded age.
- **C19. The 402 balance text is parsed as untrusted input.** (Retired 25 Sep with the balance probe in C7: no balance text is parsed any more. A 402 on a case call is still classified only by status and error type, never by its message.)

### Output

- **C20. Everything rendered on the report page and returned by the run API is escaped as text at the render boundary.** No prompt, case input, expected value, answer, or lint rewrite is inserted as HTML or rendered through a markdown renderer that permits raw HTML. Test: an answer of `<img src=x onerror=alert(1)>` renders as visible text.
- **C21. Anything exported or copied out of a report (CSV, JSON, the one-click rewrite) is validated for the consumer it is going to.** CSV cells that begin with `=`, `+`, `-`, `@` are prefixed, JSON is produced by a serialiser, and the rewrite is delivered as text to copy, never applied automatically to a stored workload without the owner token.
- **C22. The API refuses cross-origin credentialed requests.** The key header is a custom header, CORS stays at default deny, and the browser keeps the team key in page memory only, not in `localStorage`. (Amended at the backend gate review, 23 Sep: the run owner token is also a capability, since it can spend on a demo run and publish a report; the browser keeps it in `sessionStorage` at most, never `localStorage`, so it dies with the tab.) (Amended 24 Sep: the run page can hand the owner token back to its owner as a private run link, only when the owner presses copy. The token sits after `#`, which browsers never send to a server or put in a Referer header. On load the page moves it into `sessionStorage` and strips it from the address bar. The link never carries the SERV key, so reopening a team run still needs the key pasted again before anything is spent.) (Amended 26 Sep: a run opened from a private link shows what a key would pay for, its settings, calls left and the start of its prompt, and needs an explicit confirm before any key field appears. A team key is held per run id and is never reused by another run in the tab.)

### General standards

**C23. Primitives over lists.**
- Id entropy: one CSPRNG call, not a format check. Covers guessing; does not cover an id that leaks through a referrer or a screenshot.
- Payer decision: one enum on the run row read in one place. Covers header games; does not cover an operator who mislabels a workload as a sample.
- Schema safety: the validator's own strict mode, remote-ref-off and depth options, not a blocklist of keywords. Covers the keywords the library knows; does not cover a library bug, so C13's timeout backs it.
- Regex safety: a linear-time engine or a timeout primitive, not a review of patterns by eye. Covers backtracking; does not cover memory blowups from enormous inputs, so C14's caps back it.
- Escaping: the framework's default text rendering, with no `dangerouslySetInnerHTML` anywhere in the report tree. Covers HTML injection; does not cover a browser extension or a phishing copy of the page.

**C24. Normalise before you compare.**
- Expected value and model answer go through the same coercion function at score time (C15). Neither side is pre-normalised at store time.
- The schema used to reject a workload and the schema used to score answers are the same compiled object from the same library version (C12).
- The model id checked by the lint and the model id sent to SERV pass through one trim-and-case policy.
- The budget window date is computed by one function used for both reservation and reporting (C6).
- The workload is stored as `json` text, not `jsonb`, so the answer schema reaches SERV with its properties in the order the team wrote them. (Amended 26 Sep: `jsonb` had sorted object keys by length, so SERV received a reordered schema. SERV off and SERV on always got the same schema, so each comparison was like for like, but it was not the agent as written.)

**C25. Validate outputs like inputs.**
- Answer text, prompts, expected values and rewrites are inputs to the browser (C20) and to any export (C21).
- Token counts and latency are inputs to the cost and speed tables; a null must show as unknown, not as zero (C17).
- Costs in a report come from SERV's token counts. The only balance numbers Urai shows are readings taken before 25 Sep and stored with the reports of that time; the current samples, re-run on 26 Sep, carry none (C7).
- Log lines are outputs to the operator's log store; C1 forbids the key there and C14 caps prompt text there.

**C26. Fail closed.**
- Unknown run mode, missing budget row, unreadable counter, schema compile failure, regex timeout, oversized body, unexpected upstream status, and a 200 on the probe all deny or abort. None default to "proceed".
- Explicit numbers the implementation must carry in one config file: upstream timeout, body cap, schema size and depth, answer cap, cases per workload, configurations per run, concurrent case calls per run, probes per day, daily demo budget, id byte length. A cook's report lists the values.
- New reports are private, new workloads have a retention period, and the operator key is readable only by the demo case handler and the model list refresh (which sends no user text, so C4 holds).
- Storage cannot fill: stored team workloads are capped in total, a workload that never got a run is deleted after 48 hours, and every database query times out after 15 seconds. (Added 26 Sep: a few addresses could otherwise fill the free database in a day, after which every rate-limited route fails closed.) (Amended in review pass 2: new calls and workload saves also stop at 400 MB of total database size, read at most once a minute, because stored answers are not in the workload cap.)

**C27. Named non-goals.** This component does not defend against:
- A team member who pastes their key into a hostile copy of the site, or a compromised browser or extension on their machine.
- OpenServ retaining or reading request content sent with a team's own key; that is under the team's own OpenServ settings. (Amended 26 Sep: the builder says beside its Start button what Urai keeps and that OpenServ may keep request content.)
- A team that chooses to share a report and thereby publishes its own prompt, cases and expected answers. (Amended 26 Sep: the share panel lists exactly what becomes public and asks for a second confirm, so the choice is an informed one.)
- Whether SERV's answers, token counts or latencies are truthful. The product reports what the API returns.
- Loss of team credit when a case call sends the request and then dies before storing the result. The run marks the case as unknown and the team may re-run it; the double spend on the team's side is accepted and documented.
- Denial of service against Vercel or OpenServ themselves, beyond the caps in C14 and per-IP creation limits.
- Operator error: a wrong sample workload label or an oversized daily budget is a configuration mistake, not a code defense.
- A caller holding a whole IPv6 /48. Per-address limits group IPv6 callers by /64, so such a caller counts as many addresses. The money and storage caps (C6, C26) still hold in total. (Accepted 26 Sep at the final review; a second, looser /48 bucket is the fix if it is ever needed.)

### Added at the backend gate review (23 Sep 2026)

The review read the whole backend against C1 to C27 and asked what the standard misses. These close the gaps it found.

- **C28. The demo budget holds on settled cost.** (Rewritten 25 Sep, when SERV stopped offering a free balance read.) Each demo call reserves an estimate before it runs (C6) and settles at its real cost from SERV's token counts, priced at the higher of the configured price and SERV's live price for that model; the daily cap applies to the settled total. The one charge token counts cannot see, SERV's one-off reasoning-graph build for a system prompt it has not seen, cannot arise on the demo: demo runs only use the sample workloads on the allowlisted model, and their prompts are pre-warmed and held in SERV's 30-day cache (re-warm before 23 Oct 2026). The operator can stop the demo globally with the `demo_off` flag, or for one UTC day with `demo_budget.stopped`. (Amended 26 Sep: demo calls carry max_completion_tokens, so a runaway answer cannot cost more than its reservation, which is sized from the higher of the table and live price. Lowering DEMO_DAILY_BUDGET_USD takes effect the same day. From 23 Oct 2026 demo calls in any SERV mode other than raw are refused until the operator re-warms the sample prompts and moves the date in config.)
- **C29. Every response body has a stated size cap.** Inputs were capped by C14; outputs were not. The run status endpoint returns status only, never answers; the report caps every answer by its serialised length as well as its text; the caps live in the config file. (Amended 26 Sep: an answer is capped by the length of the indented form the report page renders; a deeply nested answer grew about 1,000 times from its compact form.)
- **C30. The owner can take a shared report back.** The run owner token can make a public report private again, and the public route answers 404 from then on.
- **C31. Public reads are rate-limited.** The public report route does real work per request (schema compile and lint over the stored workload), so it is limited per client address like every write route. (Amended 24 Sep after the final review: the landing page and /try also read stored sample reports and workloads on every request; they serve them from a short server cache instead, since the samples never change.) (Amended 26 Sep: the owner report route and the model list route are metered too, and a model list refresh is single-flight behind a database lease.)
- **C32. One model id policy everywhere.** Run settings, the demo allowlist, the lint, pricing and the request all compare and send model ids through the engine's single normaliser (trim, lowercase), so one setting can never appear as two.
- **C33. Outbound refusals are budgeted.** Urai forwards a caller's key to SERV, so it must not become an unlimited relay for keys SERV refuses. Every team call SERV refuses with 401 or 402 counts against a per-address hourly budget, and once the budget is spent the case route refuses team calls from that address with 429 before any request leaves for SERV. A key SERV accepts is bounded already: each (run, case, setting) is spent at most once (C5). (Added 24 Sep at the final review.) (Amended 26 Sep: the budget is charged before a team call leaves and refunded when SERV accepts the key, so calls in flight cannot slip past it. A call that never reached SERV, or that SERV answered with 429, keeps its charge.) (Amended again 26 Sep, review pass 2: every SERV answer that is a 4xx other than 429 counts, not only 401 and 402; a call that never reached SERV or got 429 counts against its own per-address bucket instead, so an outage cannot lock out a good key; a refused attempt never adds to any count.)
- **C34. The browser only talks to Urai, as far as a policy can say.** Every production page sends a Content-Security-Policy that limits scripts, styles, fonts and images to Urai's own origin and connections to `'self'`, forbids framing, and sends `X-Content-Type-Options: nosniff`, so a script that somehow ran in the page could not fetch from or post to another host. A policy cannot stop a script from navigating the tab away or opening a WebRTC channel, so what protects the key is C20 (no injected markup) and the absence of third-party scripts; C34 is defence in depth. (Added 24 Sep at the final review; reworded 26 Sep, when review round 1 showed the first wording claimed more than a policy can deliver.)
- **C35. The live app's database login can do only what the app needs.** (Added 26 Sep.) The app connects as `urai_app`, a role created with SQL, so it is not a member of `neon_superuser`, with column-level grants: it reads and writes the rows the code writes, and cannot create, alter or drop anything, read the migration log, set flags, change a run's payer or a workload's owner, or create roles. The owner login stays in the operator's local `.env` for migrations, seeding and the test suite. Checked by `npm run check-app-role`. (Amended 26 Sep, review pass 2: the retention deletes run inside one SECURITY DEFINER function with a fixed search_path, and the app's login has no DELETE on the budget, rate-limit, workload or run tables, so even a compromised route cannot reset its own limits.) (Amended 26 Sep, review pass 3: releasing a refused call also runs through a SECURITY DEFINER function that deletes only that one unfinished claim, so the app's login has no DELETE on stored answers either.)
