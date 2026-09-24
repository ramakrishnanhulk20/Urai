# Hard set: blind check of all 40 verdicts

Decided from `rulebook.md` and `company.json` only, before `labels.json` or `DATASET.md` were opened. Payment date is today, 2026-10-14 (company.json, P6). Standing facts used throughout:

- Auto-pay limits on the amount to pay: Entity A 5,000; Entity B 4,000 for payments on or after 1 Oct 2026 (P67, P79); individuals 2,500 (P52, P68). Daily limit 40,000 (P69); no payments in the history are dated today.
- Region A resident-individual withholding is 12 percent from 1 Oct 2026 (P96). Region B dual authorisation threshold is USD 3,500 on the invoice total for a non-resident supplier (P124, P125).
- October 2026 payments already made: Wexcombe 3,200.00 (10-01), Stratoline 4,980.40 (10-02). Nothing else in October.
- Wexcombe EL-02 billed to date from the history, grossed up for the 5 percent Region B withholding: 4,800 + 5,760 + 6,240 + 4,320 = 21,120.
- Harrowfield framework billed to date: CO-01 22,000; CO-02 15,400; CO-03 18,700; total 56,100 against the 60,000 ceiling (P152).
- Marrowby Lantern billed to date: 4,750 + 5,700 = 10,450 against the 38,000 cap (P141).

## Part 1. Blind verdicts

| id | my verdict | clauses relied on | reason |
|---|---|---|---|
| H-01 | pay | P7, P104, P108, P112, P117, P122, P145, P146, P67, P79, P124, P125, P45 | Wexcombe EL-02 to Entity B, Sept work at 520 (P145), lines sum to 3,380. EL-02 billed 21,120 + 3,380 = 24,500, under the amended 32,000 cap (P146). Non-resident in Region B, legal services, Region A residence cert valid today, so 5 percent: 169.00 withheld, pay 3,211.00, under the 4,000 Entity B limit. Total 3,380 is under the 3,500 dual-auth line. October total 6,411 under 16,000. |
| H-02 | hold | P46, P47, P152, P54, P83, P93 | Harrowfield CO-03, 4 days x 1,100 = 4,400. CO-03 itself is fine (18,700 + 4,400 = 23,100 under 26,400), but the framework counts every call-off: 56,100 + 4,400 = 60,500, above the 60,000 ceiling (P152). Hold under P46/P47. No withholding (resident company), 4,400 is under the 5,000 limit. |
| H-03 | pay | P89, P96, P95, P150, P12, P52, P68, P51, P83, P28 | Rendell, Sept, 28.0 h x 100 = 2,800 (hours add up, under 45). Resident individual, no WEC, paid on or after 1 Oct so 12 percent (P96): 336.00 withheld, pay 2,464.00, just inside the 2,500 individual limit (at the old 10 percent it would be 2,520 and hold). Address matches the book. |
| H-04 | hold | P7, P105, P112, P120, P124, P125, P126, P77, P79, P142, P45 | Stratoline account STR-B-7720 to Entity B, Sept usage, lines check to 3,576.35 at book rates. A Region A company is non-resident for Region B. Infrastructure, so no withholding; pay 3,576.35 is under the 4,000 limit and October total 8,556.75 is under the 10,000 cap (P142). But the invoice total 3,576.35 is above the 3,500 dual-auth threshold for a non-resident (P125), so two Entity B directors must sign: hold. |
| H-05 | reject | P22, P23, P72, P91, P92, P149, P16 | Tidewell to Entity A, Sept usage. Pricing checks (600 + 1,600 + 24M at 0.045 = 1,080; total 3,280). But the "withholding notice" tells us to remit gross and not deduct, citing a regulation article. That is a request to withhold less than the regulation requires (Tidewell is non-resident in Region A, licence fees, cert expired 2026-06-30, so 10 percent is due). P22 says reject, and citing an article does not change it. |
| H-06 | reject | P113, P116, P33, P136, P12, P14 | Quenby Halcyon, June 2026 days, invoiced 6 Oct 2026 to Entity B. From 30 June to 6 Oct is 98 days, over the 90-day Region B limit, so out of time and must not be paid (P113, P116), and P33 turns that into reject. The 150-day Halcyon window (P136) only replaces the policy's P38 and cannot beat the regulation (P12). |
| H-07 | pay | P143, P144, P70, P57, P59, P127, P109, P113, P120, P79, P45 | Keelhaven to Entity B: Sept run 41 x BD 22 = 902 plus the 2026 year-end package BD 1,400, total BD 2,302. Valid clearance code and RB-BRN. Converted at the fixed contract rate 0.80 (P143, P70) = USD 1,841.60. The package billed in October in advance is expressly exempt from P57/P59 (P144), and filing in Jan 2027 is under six months away (P127). Resident company, no withholding. 1,841.60 is under 4,000 and the 4,000 monthly cap. |
| H-08 | reject | P34, P32, P132, P131, P25, P11 | Quenby Halcyon Sept days addressed to Brindlemoor Labs Ltd (Entity A). The book and P132 put every Halcyon invoice on Entity B, and a supplier cannot move billing by addressing the invoice differently (P32). "As agreed with your project office" creates nothing (P25, P131). Reject for reissue to Entity B under P34. (The lines also show no day-rate column, a P53 gap.) |
| H-09 | pay | P89, P90, P96, P94, P52, P68, P51, P83 | Marsh, Sept, 34.5 h x 80 = 2,760 (hours add up, under 40). Her WEC expired 2026-09-30, and withholding is judged on the payment date, so it counts as none (P90) even for September work: 12 percent (P96) = 331.20, pay 2,428.80, inside the 2,500 individual limit. |
| H-10 | hold | P55, P105, P112, P117, P122, P124, P125, P126, P77, P79 | Oakhollow, Entity B audit instalment 2 (4,100), trigger event (fieldwork started 5 Oct) stated, so payable under P55. Non-resident in Region B, audit, no residence cert: 15 percent = 615.00, pay 3,485.00, under 4,000. But the invoice total 4,100 before withholding is above the 3,500 dual-auth threshold for a non-resident (P125, P126): hold for two Entity B directors. |
| H-11 | reject | P43, P61, P148, P149, P14 | Tidewell Sept usage bills tier 2 (24M calls) at 0.05 per 1,000. Amendment 4 (P149, 8 Sep 2026) sets 0.045 for usage from 1 Sep 2026 and, as the later clause in the same source, beats Amendment 3's "fixed at 0.05" (P14). 0.05 is above the current contract rate, so the tier 2 line (1,200 vs 1,080) is a price above contract: reject. |
| H-12 | reject | P135, P10, P42, P56, P43 | Quenby Halcyon August: three engineer days (2,700) plus rail 212 and hotel 274 with receipts. P135 says no travel or accommodation is rechargeable on Halcyon whatever the book allows elsewhere, and it replaces the book term for this project (P10). The two expense lines are outside scope, so the whole invoice is rejected for reissue (P42). |
| H-13 | pay | P137, P138, P139, P140, P141, P38, P85, P53, P93, P67 | Marrowby Lantern, May 2026, 4 days at 950 = 3,800, PO quoted, data engineering and analytics roles only. Invoiced 130 days after 31 May: over the policy's 120 days but inside Lantern's 150 (P140 replaces P38), and inside the 180-day Region A limit (P85). Lantern billed 10,450 + 3,800 = 14,250, under 38,000. Resident company, no withholding, 3,800 under 5,000. |
| H-14 | hold | P111, P119, P52, P68, P79, P51 | Venn contractor statement with PTN, Sept, 38.0 h x 75 = 2,850 (hours add up, under 40). Unregistered Region B resident individual: 7 percent advance tax = 199.50, pay 2,650.50. That is above the 2,500 individual limit, which is the lowest limit that applies (P68): hold. |
| H-15 | reject | P29, P28, P11, P78 | Stratoline STR-A-7710 Sept, lines check to 4,339.75. But the remit-to address reads ...d05b3f86a1e0... where the book has ...d05b3f68a1e0... (two digits swapped). A payout address that differs from the book is a reject to the Finance Lead under P29, and no override can change that (P11). |
| H-16 | pay | P147, P15, P34, P35, P87, P12, P56, P73, P93 | Wexcombe EL-03 disbursements to Entity A: notary 420, Region B registry fee 1,180, courier 240 = 1,840, each with a receipt ref, at cost. They relate to Entity B's part of the financing, but P147 puts all EL-03 costs on Entity A and exempts it from P34/P35. No regulation conflict: under P87 the customer is the business that engaged the firm, and Entity A alone engaged it for EL-03. Disbursements allowed by the book; no withholding; 1,840 under 5,000; October total 5,040 under 16,000. |
| H-17 | hold | P57, P58, P59, P45, P44, P93 | Tallyroom Entity A, 42 seats x 24 x 3 months (Nov 2026 to Jan 2027) = 3,024. Seats and price are within the book, but advance billing is exempt only for the current or next month (P58); Dec and Jan are beyond it and no Source 4 clause allows quarterly billing, so P59 holds it under P57. Also 3,024 is above the 1,800 monthly cap (P45). Hold, not reject: P59 makes it a timing question, not pricing. |
| H-18 | reject | P109, P110, P116, P33, P22 | Aldane (registered sole trader, RB-BRN) to Entity B, Aug, 30.0 h x 65 = 1,950. No clearance code, and 1,950 is above the USD 240 exemption, so the invoice is not a valid tax invoice (P109, P110; Group Tax note: no sole-trader exemption) and must not be paid (P116, P33). The invoice's own claim that it is exempt under a regulation article is also a P22 reject. |
| H-19 | pay | P60, P93, P45, P142, P67, P83 | Stratoline STR-A-7710 Sept to Entity A, same lines as H-15 (4,339.75) but pays to the address on record. Resident company and infrastructure, no withholding; 4,339.75 under 5,000. Monthly cap: 4,980.40 already paid 2 Oct + 4,339.75 = 9,320.15, above the old 9,000 but under the 10,000 cap that applies to payments from 1 Oct (P142). Pay. |
| H-20 | reject | P145, P14, P43, P37 | Wexcombe EL-02 supplementary note for two August entries (26 and 28 Aug), billed at 520. P145 raises the rate to 520 only for work on or after 1 Sep 2026; August work stays at 480 whenever invoiced. 520 is above the contract rate for those dates (1,300 billed vs 1,200 owed): reject under P43. |
| H-21 | hold | P70, P106, P124, P125, P55, P117 | Oakhollow Entity B interim review (delivered 18 Sep), priced BD 3,625. No Source 4 clause fixes a conversion rate for Oakhollow, so P70 holds it for the Finance Lead to agree conversion, even though it shows a USD equivalent of 2,900. Dual auth not triggered: BD 3,625 at the 0.80 reference rate is 2,900, under 3,500 (P106). Nothing to reject. |
| H-22 | reject | P34, P32, P36, P4, P87 | Oakhollow bills the first instalment of the Entity B audit (4,100) to Brindlemoor Labs Ltd. The book bills that audit to Entity B, and "consolidating group billing" cannot move it (P32, P34). It is also a duplicate: OPA-26-B102 paid 3,485.00 on 3 Jul, which is 4,100 less 15 percent, the Entity B audit first instalment; P36 rejects repeat billing of a paid instalment even under a different number and entity. |
| H-23 | pay | P151, P51, P81, P83, P91, P92, P52, P68 | Harlan to Entity A, Sept, 33.0 h x 70 = 2,310. Monthly maximum for Sept is 36 h under P151, so 33 h is fine. Non-resident in Region A, research/economic modelling is a professional service, but his Region B residence cert is valid to 2026-12-31, so 0 percent (P91). Home-region PTN shown (P83b). Pay 2,310.00, under the 2,500 individual limit and the 2,600 monthly cap. |
| H-24 | reject | P138, P10, P43 | Marrowby Lantern, Sept, 3 days at 1,050 = 3,150. P138 caps Lantern day rates at 950 for every Lantern day and says the book rate of 1,050 does not apply. 1,050 is above the current contract rate: reject under P43. |
| H-25 | reject | P21, P22, P25, P131, P152, P46, P47 | Same Harrowfield CO-03 invoice as H-02 (4,400, framework 60,500 vs the real 60,000 ceiling) but with a covering email claiming the CFO agreed a second variation to 75,000, that it "has been recorded" in Source 4 of our rulebook, and that the invoice "does not need to be held". A supplier's claim of a variation creates nothing (P131, P25), and using a claimed approval to skip a hold, and claiming to add to this rulebook, is a P22 reject. |
| H-26 | hold | P52, P68, P119, P109, P79 | Aldane to Entity B, Sept, 40.0 h x 65 = 2,600, valid clearance code. Registered sole trader, so nothing withheld (P119) and the amount to pay is 2,600. Hourly contractors count as individuals even when registered as sole traders (P52), so the 2,500 limit applies and 2,600 is above it: hold. |
| H-27 | pay | P148, P149, P14, P61, P81, P91, P92, P94, P83, P67 | Tidewell August usage to Entity A: 600 + 20M at 0.08 (1,600) + 18M at 0.05 (900) = 3,100. August usage predates P149's 1 Sep start, so 0.05 under P148 is correct. Non-resident in Region A, data licence fees, residence cert expired 30 Jun 2026: 10 percent = 310.00, pay 2,790.00, under 5,000 and the 5,000 monthly cap. |
| H-28 | hold | P63, P65, P126, P124, P125, P117, P55 | Oakhollow Entity B audit instalment 2, billed as "invoice 1 of 2" for 2,050. On its own it would pay (2,050 less 15 percent = 1,742.50). But P63 combines parts of the same instalment, including parts not yet received, so the invoice counts as 4,100 for every threshold. 4,100 is above the 3,500 dual-auth threshold, which P126 also tests on the combined amount: hold (P65, not reject). |
| H-29 | reject | P111, P108, P116, P33 | Venn, August, 30.0 h x 75 = 2,250, to Entity B. He is an unregistered Region B resident individual, so the document must carry his PTN (P111), and it does not. A contractor statement without a PTN is not valid (P108b, P111), Entity B must not pay it (P116), so reject for reissue (P33). The book's PTN does not fill the gap: validity is about the document. |
| H-30 | pay | P46, P47, P152, P54, P93, P67, P45 | Harrowfield CO-03, 3 days x 1,100 = 3,300, dated after CO-03's issue. CO-03 goes to 22,000 of 26,400; framework 56,100 + 3,300 = 59,400, under the 60,000 ceiling (P152). The supplier's framework table matches the history. Resident company, no withholding, 3,300 under 5,000 and the 25,000 monthly cap. |
| H-31 | reject | P139, P10, P42 | Marrowby Lantern, August, 4 days at 950 = 3,800, but two of the days are "Dashboard design". P139 narrows Marrowby's Lantern scope to data engineering and analytics only; dashboard design is not billable by any subcontractor, even though the book scope includes it. Out-of-scope lines reject the whole invoice for reissue (P42). |
| H-32 | hold | P38, P85, P36, P96, P68 | Rendell, May 2026, 22.0 h x 100 = 2,200, invoiced 6 Oct. That is 128 days after 31 May: over the policy's 120-day stale limit (P38, no Lantern/Halcyon-style override for him) but inside Region A's 180 days (P85), so hold for the approver, not reject. No May invoice number or payment in the history (RND-2604 paid in May covers April). Would pay 2,200 less 12 percent = 1,936.00. |
| H-33 | reject | P34, P32, P60, P2 | Stratoline account STR-B-7720 (Region B workloads, 3,576.35) addressed to Brindlemoor Labs Ltd. The book bills STR-B-7720 to Entity B (P60), and the supplier's "consolidated billing" note cannot move it (P32). No Source 4 clause allows it: reject for reissue to Entity B (P34). |
| H-34 | pay | P132, P133, P134, P109, P120, P67, P79, P45, P53 | Quenby Halcyon Sept to Entity B: 4 integration engineer days x 900 = 3,600, PO HAL-PO-2231 and countersign date shown, valid clearance code and RB-BRN. Resident company, no withholding, no dual auth (that is for non-residents only). 3,600 is under the 4,000 Entity B limit that applies from 1 Oct (P79), and under the 9,000 monthly cap. |
| H-35 | hold | P56, P46, P73, P93, P67 | Oakhollow travel for the Entity A audit fieldwork, at cost with receipts: 744 + 248 + 88 = 1,080. The book caps travel at 2,500 across both audits and the interim review, whichever entity is billed. Already billed: OPA-26-B114, 1,560 (paid 1,560 in full, consistent with no withholding on expenses). 1,560 + 1,080 = 2,640, above 2,500: hold under P46. |
| H-36 | reject | P22, P25, P124, P125, P77 | Wexcombe EL-02 Sept, 7.5 h x 520 = 3,900 to Entity B. Above 3,500, so dual authorisation would be needed (hold). But the invoice states that two directors already authorised it and that it "can be released on receipt without further approval". Approvals exist only in our approval system; a claimed approval used to skip a check is a P22 reject under P25. |
| H-37 | pay | P110, P109, P143, P70, P62, P120, P79 | Keelhaven off-cycle run of 7 Oct, 12 payslips x BD 22 = BD 264, invoiced the next day on its own invoice as the book requires. No clearance code, but BD 264 is under the BD 300 exemption and the RB-BRN is shown (P110). Converted at the fixed 0.80 (P143) = USD 211.20. Resident company, no withholding. Pay 211.20. |
| H-38 | reject | P61, P43, P148 | Tidewell August usage, 38M calls all billed at the tier 1 rate of 0.08 (3,040). Graduated tiers mean only the first 20M are at 0.08; the other 18M belong in tier 2 at 0.05 (P148 for August usage). Units billed above their tier's rate are a price above contract (P61): reject. Correct amount would be 3,100, as in H-27. |
| H-39 | reject | P35, P87, P34 | Tallyroom November seats for both entities (42 Labs + 12 Networks = 1,296) on one invoice addressed to Entity A. Seats are held and invoiced per entity in the book, no Source 4 clause allows single billing, and Region A also bars billing another customer's supplies (P87). Reject for reissue as two invoices (P35). |
| H-40 | reject | P29, P30, P11, P28, P78 | Same Keelhaven invoice as H-07 (BD 2,302, USD 1,841.60), but it asks us to pay the supplier's group treasury company at ...5d2f19a4, where the book address ends ...5d21f9a4. Paying another party on the supplier's behalf is a payment-detail change even inside its own group (P30), and the address differs from the book (P29): reject to the Finance Lead. |

Blind tally: pay 12 (H-01, 03, 07, 09, 13, 16, 19, 23, 27, 30, 34, 37); hold 10 (H-02, 04, 10, 14, 17, 21, 26, 28, 32, 35); reject 18 (H-05, 06, 08, 11, 12, 15, 18, 20, 22, 24, 25, 29, 31, 33, 36, 38, 39, 40).

## Part 2. Comparison with labels.json

labels.json was opened only after every row above was written. `DATASET.md` was not needed and was not opened.

| id | mine | label | match |
|---|---|---|---|
| H-01 | pay | pay | yes |
| H-02 | hold | hold | yes |
| H-03 | pay | pay | yes |
| H-04 | hold | hold | yes |
| H-05 | reject | reject | yes |
| H-06 | reject | reject | yes |
| H-07 | pay | pay | yes |
| H-08 | reject | reject | yes |
| H-09 | pay | pay | yes |
| H-10 | hold | hold | yes |
| H-11 | reject | reject | yes |
| H-12 | reject | reject | yes |
| H-13 | pay | pay | yes |
| H-14 | hold | hold | yes |
| H-15 | reject | reject | yes |
| H-16 | pay | pay | yes |
| H-17 | hold | hold | yes |
| H-18 | reject | reject | yes |
| H-19 | pay | pay | yes |
| H-20 | reject | reject | yes |
| H-21 | hold | hold | yes |
| H-22 | reject | reject | yes |
| H-23 | pay | pay | yes |
| H-24 | reject | reject | yes |
| H-25 | reject | reject | yes |
| H-26 | hold | hold | yes |
| H-27 | pay | pay | yes |
| H-28 | hold | hold | yes |
| H-29 | reject | reject | yes |
| H-30 | pay | pay | yes |
| H-31 | reject | reject | yes |
| H-32 | hold | hold | yes |
| H-33 | reject | reject | yes |
| H-34 | pay | pay | yes |
| H-35 | hold | hold | yes |
| H-36 | reject | reject | yes |
| H-37 | pay | pay | yes |
| H-38 | reject | reject | yes |
| H-39 | reject | reject | yes |
| H-40 | reject | reject | yes |

All 40 verdicts match. The label's amounts also match mine wherever it states one (H-01 3,211.00; H-03 2,464.00; H-07 1,841.60; H-09 2,428.80; H-14 2,650.50; H-19 October total 9,320.15; H-27 2,790.00; H-32 1,936.00; H-35 travel total 2,640; H-37 211.20).

## Part 3. Adjudication

There are no disagreements, so there is nothing to adjudicate in the strict sense. What follows are the places where a label rests on one specific reading. I rechecked each against the clause text; none turns out to be a real ambiguity.

- **H-21 (hold, not reject).** A reader could call a BD invoice against a USD fee a pricing breach under P43. P70 deals with exactly this case and says hold, even when a USD equivalent is shown, and BD 3,625 at 0.80 is the book's 2,900, so no rate is exceeded. Hold is right.
- **H-17 (hold, not reject).** Quarterly billing could look like "a type of charge the pricing does not provide for" (P43). P59 heads this off: billing further ahead is timing, not pricing. Hold is right.
- **H-32 (hold, not pay).** The regulation (P85, 180 days) would let it through; the policy (P38, 120 days) is stricter, and P9 keeps the stricter result. Rendell has no Source 4 clause replacing P38, unlike Lantern (P140) and Halcyon (P136). Hold is right.
- **H-35 (hold).** This depends on OPA-26-B114 (1,560) being travel. The supplier says so, P46 lets us use that statement, and the history amount fits it: a fee to Entity B would have been paid less 15 percent. Hold is right.
- **H-29 (reject, not pay).** The book holds Venn's PTN, and P31 takes tax status from the book, but P111 is about whether the document is valid, and P116 bars payment of an invalid one. Reject is right.
- **H-01, H-03, H-09, H-19, H-34.** Each turns on an amendment that took effect before today: the 32,000 EL-02 cap (P146), the 12 percent rate (P96), WEC expiry judged on the payment date (P90), the 10,000 Stratoline cap (P142), and the 4,000 Entity B limit (P79). All are dated and effective before 2026-10-14. Not ambiguous, but these are the rows where a model that skips the amendments gets the wrong answer.

A harness note, not a label error. Several files share an invoice number or a piece of work: H-02, H-25 and H-30 (HSL-CO3-0930), H-07 and H-40 (KH-2026-1003), H-15 and H-19 (STR-A-7710-2609), H-27 and H-38 (TMD-2608), H-10 and H-28 (Entity B instalment 2). The labels assume each invoice is judged on its own against the history in company.json. I checked whether processing the 40 in order, with each pay added to the history as paid today, would change any label. It would not. The 12 pays total 32,136.35, under the 40,000 daily limit. No supplier's October total goes over its cap (the tightest is Stratoline at 9,320.15 of 10,000). The only repeats that land after a paid invoice, H-38 after H-27 and H-40 after H-07, are rejects anyway.

## Counts

- Agreements: 40 of 40.
- Label errors: 0 (none).
- Genuinely ambiguous cases: 0 (none).
