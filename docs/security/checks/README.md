# Security checks

Urai has a written threat model (`docs/security/threat-model.md`). Section C lists the rules the code must keep: a team's SERV key never stored or logged, the payer fixed when a run is created, ids that cannot be guessed, hostile schemas refused, and so on. This suite tries to break each rule against a running server and writes down what came back.

Every check sends a real HTTP request that the app must refuse or handle safely. Where a response alone cannot prove the rule, the check also reads the database. For example, after refusing a call it confirms that no case result was claimed, and it searches every stored row for the test key.

## How to run it

```
cd packages/web
npm run verify-security -- --base http://localhost:3102 --server-log <file> [--skip-budget]
```

- `--base` is the server to test. It must be https, or http on localhost.
- `--server-log` is the file holding the server's own output. The key check searches it for the test key.
- `--skip-budget` skips the two checks that make real demo calls on the operator's key (about four calls, a fraction of a cent).

The suite reads the root `.env` to reach the same database the server uses. It never prints a value from that file.

## What the results mean

- **OK**: the app refused, or behaved exactly as the rule says.
- **BROKEN**: the rule did not hold, or a check could not finish. Either way the run exits non-zero.
- **PENDING**: the rule is checked somewhere else later. No check is pending today: C20 fetches the real report page and requires the test markup to appear only escaped.

C15 to C19 are proved by unit tests rather than requests. The suite lists those tests and confirms each one still exists.

## What it cleans up

At the end the suite deletes every workload, run, case result and rate-limit counter it created, and nothing else. It never touches the sample workloads. Money spent on real demo calls stays counted in the day's budget, because it was really spent.

## The record

Each run writes `run-<time>.md` in this folder: every check, what it sent, what came back, and OK or BROKEN. The test key is never written out. It appears only as `serv_testkey_<40 random characters>`.

## What it does not cover

It tests one server instance. It does not test the Vercel edge (which sets the client address the rate limits count), scripts running in a real browser (C20 checks the served HTML), or a database outage. The fail-closed paths for an outage were checked by reading the code, not by running it.
