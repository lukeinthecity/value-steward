# Security Policy

Value Steward is a personal research project — a live **paper-trading** agent, not a maintained
product with an SLA. It does handle real credentials though (Alpaca API keys, a Google Gemini
key, SMTP), so a vulnerability here could still mean real credential theft or unauthorized
trading actions, even though no real capital is at risk on the trading side.

## Reporting a vulnerability

Please use GitHub's [private vulnerability reporting](../../security/advisories/new) — the
**"Report a vulnerability"** button under this repo's **Security** tab — instead of a public
issue. It opens a private draft advisory so nothing gets disclosed before a fix ships.

There's no bug bounty and no guaranteed response time, but reports will be looked at and a fix
or mitigation will be pushed as soon as practical. Credit is welcome if you'd like it.

## Scope

In scope: the Node.js (World layer) and Python (Brain/Execution layers) code in this repo, and
the CI/tooling around it. Credential handling and anything that could let untrusted input reach
a trading action or exfiltrate a secret are all high priority.

Out of scope: Alpaca, Google Gemini, ntfy.sh, and any other third-party service this project
integrates with — report issues in those upstream.

## A note on secrets

All credentials belong in the git-ignored `.env` — see `.env.example`. If you believe real
credentials ever landed in this repo's tracked history, please report it privately rather than
filing a public issue.
