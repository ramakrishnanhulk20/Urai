# Hard invoice bench dataset

## What it is for

The easy set (`data/`, 43 clauses) left no headroom: gpt-6-luna scored 96 to 100 percent without SERV. This set tests the case Multipath was built for, a long rulebook whose sources conflict and override each other. It is hard because rules interact, not because of trick wording. Run it with `BENCH_DATA=data-hard`.

## Files

- `company.json`: Brindlemoor Group, two entities (Brindlemoor Labs Ltd in Region A, Brindlemoor Networks Ltd in Region B), 14 suppliers and 39 past payments. Today is 2026-10-14. `autoPayLimitUsd` is 5,000, the Entity A limit and the highest one; the rulebook sets lower limits for Entity B and for individuals. No payments are dated today.
- `rulebook.md`: 152 clauses, about 7,100 words, four sources in one file: the payables policy (P1 to P79), the Region A regulation (P80 to P103), the Region B regulation (P104 to P130), and contract overrides (P131 to P152: client flow-down terms for two projects and supplier amendments).
- `invoices/H-01.txt` to `H-40.txt`: invoice text as a PDF extractor returns it, plus one covering email.
- `labels.json`: verdict, every clause the verdict depends on, and the reasoning chain.

## Precedence in five lines

1. Only the regulation of the billed entity's region applies (P7).
2. Regulation beats policy, except that a stricter policy result also stands; policy never reduces withholding (P8, P9).
3. Contract overrides beat policy for what they name, but never touch the protected clauses (P10, P11).
4. Contract overrides never beat regulation, whatever their date (P12).
5. Within one source, a later-dated amendment beats an earlier one from its effective date, which can be retroactive (P14).

## Counts

- 26 honest invoices: 12 pay, 8 hold, 6 reject. 23 of them need three or more clauses from at least two sources. Most are built so that one clause read alone gives the wrong verdict and a later or higher-precedence clause flips it: withholding that brings an amount under a limit (H-03, H-09), a gross-payment contract clause the regulation overrides (H-03), amendments with effective dates that do or do not reach the invoice (H-01, H-11, H-20, H-27), a policy limit raised by amendment but undercut by a regulatory threshold on the gross (H-04, H-10), override windows that beat the policy but not the regulation (H-06, H-13), and a stricter policy rule standing over a looser regulation (H-32).
- 14 attacks: 12 reject, 2 hold (the call-off aggregation and the split invoice, which the rulebook holds).

| Attack category | Count | Code alone catches |
|---|---|---|
| injection-regulation-citation (fake exemption articles) | 2 | 0 |
| injection-fake-override (claimed contract variation) | 1 | 0 |
| injection-fake-authorisation (claimed dual authorisation) | 1 | 0 |
| payment-detail-change | 2 | 2 |
| scope-under-client-override | 2 | 0 |
| wrong-entity (limit and control shopping) | 2 | 0 |
| cap-aggregation-across-call-offs | 1 | 0 |
| split-invoice | 1 | 0 |
| inflated-tier-pricing | 1 | 0 |
| duplicate-cross-entity | 1 | 0 |
| Total | 14 | 2 |

`codeCatches` follows the easy set's rule: plain code with the supplier book and history (exact name match, pay the book address, reject a known invoice number, hold above 5,000 or the daily limit). Honest invoices are always false. Every attack amount is 5,000 or less, so code catches only the two payment-detail changes.

## How the labels were checked

Every verdict was re-derived from the rulebook, book and history alone, and every amount, hour total and day count was recomputed by script. Two independent blind reviews were started but their reports did not come back, so this set has had one careful re-derivation, not an independent one. That pass found three places where two careful readers could disagree. Each was fixed by tightening the rule or the invoice, never by changing a verdict: P33 now says an invoice a regulation calls invalid or out of time is rejected, not held (H-06, H-29); P87 defines the customer as the business that engaged the supplier, so the EL-03 group billing clause does not collide with the one-customer rule (H-16); P53 now gives an outcome for a missing role and the Marrowby invoices show roles (H-13). An independent blind check before the first scored run is still worth doing.

## Known limits

- Synthetic and single-author: one person wrote the rules, invoices and labels, so the set tests this rulebook's interactions, not payables in general.
- Several invoices share a supplier and a month (doctored copies of an honest invoice, as in real fraud). Judge each invoice alone; never feed the set as one queue.
- Some verdicts need arithmetic (withholding, BD conversion, tier sums, day counts). A model that reasons correctly but adds badly scores wrong. That is part of the test, but it means errors are not all rule errors.
- The runner asks for `amountUsd` "from the invoice text", so the code check tests the invoice total, not the amount to pay after withholding. No verdict in this set depends on the difference.
- 40 cases is small; report counts, and run each mode more than once.
