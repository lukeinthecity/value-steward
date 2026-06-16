# Counterfactual Learning — What We Grade, and What We Refuse To

**Status:** Foundational design principle. This is the lens for evaluating any
proposed learning signal in Value Steward. Last updated 2026-06-16.

---

## The core rule

> The system learns **only** from counterfactuals the market actually
> resolved into a price. It never fabricates the outcome of a path the market
> did not print.

Said plainly: **known fact, and inference grounded in real market data —
nothing imagined.** A trained policy is only as honest as the outcomes it was
graded against. The moment we let it learn from assumed outcomes, it begins to
optimize for a fantasy and the whole loop becomes self-delusion.

The most valuable signal in this system is the road not taken — but only the
roads whose destination the market made observable.

---

## The litmus test (apply to every learning signal)

Before any data point is allowed to update the policy, ask:

> **Did the market print the outcome of this alternative, or am I assuming it?**

- **Printed** → trustworthy. Learn from it.
- **Assumed** → label it an assumption, keep it out of the training target, and
  treat any analysis built on it as a hypothesis, never as ground truth.

If you cannot point to the specific market data that resolved the
counterfactual, it does not belong in the trainer.

---

## The three layers

Counterfactual reasoning splits into layers that differ sharply in how
observable they are. Trustworthiness decreases as you go down.

### Layer 1 — Declined decisions (observable; live since Phase 1)

*"We chose not to buy X. What did X do next?"*

Fully observable: X has a real forward price. Every `BUY_BLOCKED` row in the
scorecard gets its true 1d/5d/20d `excess_vs_benchmark` computed and fed to the
trainers (signal weights, posteriors, OOS). This is the gold standard and the
backbone of the existing ML loop.

**Status: operating.** This is what the Phase 1 counterfactual scorecard does.

### Layer 2 — Execution alternatives (observable; queued as backlog 2.7 / 2.8)

*"We decided to buy KALV but our mid-point limit never filled. What did KALV do
next, and would crossing the spread have paid off?"*

Still fully observable — KALV's forward return is a printed fact, and the spread
cost we would have paid is knowable. So we can honestly answer "was the Fishing
strategy's spread saving worth the missed fill?" without guessing.

**Status: queued.** See `ML_BACKLOG.md` 2.7 (intent→fill linkage) and 2.8
(fill-rate metric / conviction-scaled execution). Worked example below.

### Layer 3 — Sizing and portfolio paths (mostly UNobservable; handle with care)

Some of this is observable:

- *"Would $12 of AFBI have beaten $8?"* — observable; AFBI's return is the same
  per dollar at sandbox size. Fine to study.

Most of it is NOT:

- *"Would the trade we made have performed the same at 10× size?"* — **not
  observable.** Our own order would have moved the market; the
  market-impact-adjusted price of a trade we never placed at scale was never
  printed. Any number here is a model assumption, not a fact.
- *"What is the equilibrium effect of our own participation?"* — unobservable
  by construction.

**Rule for Layer 3:** learn only from the per-dollar-observable slice. Treat
market-impact and scale counterfactuals as clearly-labeled modeling
assumptions — useful for sizing *hypotheses*, never as training targets. This is
the layer where undisciplined shops quietly fool themselves.

---

## Worked example — KALV, 2026-06-08

| Fact | Source | Observable? |
|---|---|---|
| Decision engine ranked KALV best (rel60 +40%, score 1.62) | `intent_log.jsonl` | yes |
| 4 mid-point limit orders placed, all expired unfilled | broker `recent_orders` | yes |
| KALV was never held | `portfolio-live.json` | yes |
| KALV's actual forward return after 6/8 | market data | **yes — printed** |
| The spread we would have paid to cross | quotes at 6/8 close | **yes — knowable** |
| Whether crossing the spread would have net-helped | derived from the two above | **yes — Layer 2, honest** |
| Whether a 10× KALV position would have returned the same | — | **no — Layer 3, off-limits as a target** |

The Layer-2 question is answerable from facts. The Layer-3 question is not, and
we will not pretend otherwise.

---

## How this maps to the roadmap

| Item | Layer | Counterfactual is… |
|---|---|---|
| Phase 1 counterfactual scorecard (live) | 1 | printed — declined-decision returns |
| OOS evaluation (live) | 1 | printed — realized policy outcomes |
| Backlog 2.4 gate post-mortem | 1 | printed — was each gate's rejection justified |
| Backlog 2.7 intent→fill linkage | 2 | printed — what filled vs. what was attempted |
| Backlog 2.8 fill-rate / conviction execution | 2 | printed — did unfilled names outperform filled |
| Backlog 2.5 predictive sell-side | 1 | printed — held-position forward trajectories |
| Any future sizing-at-scale study | 3 | **assumed — hypothesis only, never a target** |

When a new ML idea is proposed, locate it on this table first. If its outcome
is printed (Layer 1 or the observable slice of Layer 2), it's a candidate. If it
depends on an unprinted path (Layer 3 market impact), it's a hypothesis to
reason about — not a signal to train on.
