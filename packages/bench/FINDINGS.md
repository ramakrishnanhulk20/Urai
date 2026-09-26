# What the benchmark measured

The setup check in Urai quotes these figures about SERV Reasoning. This page is where they come from. All of them were measured on 23 Sep 2026 on synthetic data. Most come from this package; the graph build figure comes from the multi-turn runs in `packages/haggle`, and the table names the package for each one.

## The workload

- 40 invoices in `data/invoices/`: 20 honest, 20 attacks.
- A 43-clause payables rulebook and a supplier book, both in `data/`.
- Model `gpt-6-luna` through SERV's API at `inference-api.openserv.ai`.
- "Correct" means the model's own verdict matched the label in `data/labels.json`. Refusals, timeouts and errors count as not correct.

## The figures

| Figure | What was measured | Package and run |
|---|---|---|
| About 6,600 input tokens became about 2,100 | With the supplier book inside the system prompt, SERV rewrote the whole system prompt into its own compressed reasoning graph. | `packages/bench`, the system prompt runs in the next row |
| Accuracy fell from about 94% to 66 to 72% | Plain SERV with the rulebook and data in the system prompt: 29 of 40 (72.5%), then 53 of 80 (66.3%) on a repeat. The same mode with the data moved to the user message: 75 of 80 (93.8%). | `packages/bench`, `2026-09-23T09-46-09.670Z`, `2026-09-23T09-53-16.843Z`, `2026-09-23T10-02-28.327Z` |
| 10 of 17 answers cut | SERV's default output filter cut 10 of the 17 answers that came back in the first run, with `finish_reason` `content_filter`, because the verdicts quote the rulebook's clause ids. Sending the `serv_disable_content_filter` tool stops it. | `packages/bench`, `2026-09-23T08-40-23.023Z` |
| About 0.60 USD per graph build | The first request with a system prompt SERV had not seen cost about 0.60 USD while SERV built its reasoning graph. Cached calls after that cost well under a cent. | `packages/haggle`, the multi-turn runs `2026-09-23T11-34-44.390Z` and `2026-09-23T11-42-09.339Z` |
| About 0.25 USD and about 60 seconds per full call | Full SERV (Multipath, PromptGuard and Shadow Agent, output filter left on) cost about 0.20 to 0.30 USD per call, against about 0.001 USD for the model on its own, and took about 60 seconds per call (61 s in the run's table). The free 5 USD of credit ran out after 17 calls. | `packages/bench`, `2026-09-23T08-40-23.023Z` |
| About 0.003 USD per plain call | Plain SERV cost about 0.003 USD per call, from the key's balance changes and token counts on 23 Sep 2026. | `packages/bench`, the 23 Sep 2026 plain SERV runs |

For comparison, the model on its own (SERV off) scored 39 of 40 (97.5%) and then 80 of 80 with the data in the system prompt, and 77 of 80 (96.3%) with the data in the user message.

## What this does not cover

- Synthetic data only, written by one author.
- Depth is on `gpt-6-luna`. Other models had one or two runs each.
- Costs come from balance changes and token counts, not from SERV's billing breakdown.

## Run it yourself

Each run spends real SERV credit. Put `SERV_API_KEY` in the `.env` at the repository root, then from `packages/bench`:

```bash
npm install
# Data in the system prompt, plain SERV against SERV off, twice over
npm run bench -- --configs gpt-6-luna:plain,gpt-6-luna:raw --layout system --repeats 2
# The same with the data moved to the user message
npm run bench -- --configs gpt-6-luna:plain,gpt-6-luna:raw --layout user --repeats 2
# The default output filter left on (Multipath, PromptGuard and Shadow Agent, about 0.20 to 0.30 USD a call)
npm run bench -- --configs gpt-6-luna:serv --layout system
```

Add `--dry` to see the requests without sending them. Each run writes its answers and a `summary.md` to `results/<run id>/`, which is kept out of git. The graph build figure comes from `npm run haggle` in `packages/haggle`.
