# System description (functional, for the threat model pass)

Written 23 Sep 2026 at the architecture gate. Plain functional terms only.

## What it is

A web product that tests OpenServ's SERV Reasoning API on a team's own AI agent. The team gives it
the agent's instructions (a system prompt), an answer format (a JSON schema) and a set of test cases
with expected answers. The product runs every test case through the same model twice or more: once
with SERV switched off, and once or more with SERV switched on in different settings. It then shows
accuracy, cost, speed and token use side by side, lists the cases where the settings disagreed, and
checks the prompt layout for known setup mistakes, offering a one-click rewrite.

## Actors and where they call from

- Visitor without a SERV key (for example a hackathon judge): opens the site in a browser, reads
  saved sample reports, and can start a small live run on a sample workload paid by the operator's
  own SERV key, within a daily budget.
- Team member with a SERV key: opens the site in a browser, pastes their SERV API key, pastes or
  uploads their workload (system prompt, JSON schema, test cases as JSON or CSV), picks models and
  SERV settings, starts a run, and gets a report.
- Anyone with a report link: opens a saved report page.
- Operator (Ram): deploys the site, holds the operator SERV key in server env, sets the demo budget.

## Endpoints and flows

1. `POST /api/lint`: body is the system prompt and a sample user message. Server-side code (no model
   call) inspects the text and returns findings: structured data inside the system prompt, content
   that changes per case inside the system prompt, answers that will quote the instructions (which
   SERV's default output filter blocks), missing system prompt, streaming combined with Shadow Agent,
   unknown or retired model ids (checked against SERV's live model list), and tight token caps. Each
   finding may include a rewritten layout (for example moving data tables from the system prompt into
   the user message).
2. `POST /api/workloads`: stores a workload (system prompt, schema, cases, scoring rules per field:
   exact match, numeric tolerance, one-of list) and returns an id.
3. `POST /api/runs`: creates a run for a workload with a list of configurations (model id plus SERV
   mode: off, plain, guard, multipath, full). Returns a run id.
4. `POST /api/runs/:id/cases/:caseId`: the browser calls this once per test case and configuration,
   a few at a time, and loops until the run is done. The request carries either the team's SERV key
   in a header, or nothing (demo mode, operator key, sample workloads only). The server builds the
   request to SERV Reasoning (`https://inference-api.openserv.ai/v1/chat/completions`), sends it with
   the key, waits up to about 120 seconds, validates the answer against the schema, scores it against
   the expected values, stores the result (verdict, score, tokens, latency, finish reason, SERV request
   id, the answer text) and returns it.
5. Balance check: removed on 25 Sep. Until then the server sent SERV a deliberately oversized
   request whose 402 error stated the key's balance; SERV began running that request as a paid call,
   so Urai now reports cost from SERV's token counts and sends no balance request at all.
6. `GET /api/runs/:id` and `GET /r/:reportId`: the run status and the report page (tables, per-case
   diffs showing the case input, expected answer, and each configuration's answer).
7. `POST /api/reports/:runId/share`: makes a report public under a random link.

## Data stores

- A hosted Postgres database: workloads (system prompt, schema, cases, expected answers), runs,
  per-case results including the model's answer text, reports and share links, demo budget counters.
- Server env: the operator SERV key, the database URL.
- The team's SERV key is not meant to be stored anywhere.

## External calls

- SERV Reasoning API, with either the team's key or the operator's key. OpenServ's hackathon rules
  require data collection to be switched on for the operator's organisation, so request content sent
  with the operator key may be retained by OpenServ. Teams using their own key are under their own
  OpenServ settings.
- SERV's model list endpoint for the lint.

## Who pays for what

- Runs with the team's key spend the team's SERV credit.
- Demo runs spend the operator's SERV credit, capped per day.
- Hosting is a free Vercel plan and a free Postgres plan. Serverless functions have a 300 second limit.
