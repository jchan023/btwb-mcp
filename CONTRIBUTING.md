# Contributing

This is a small, single-maintainer wrapper around BTWB's *internal* endpoints, reverse-engineered from network traffic rather than any published spec - so a couple of things work differently than in a typical open-source project:

- **The tests are offline, and only cover the request plumbing.** `npm test` runs `test/client.test.js` and `test/builder.test.js` against a fake `fetch` (cookie rotation, retries, timeouts, privacy, and input validation for the workout-builder and scheduling tools; the fake lives in `test/support/fake-btwb.js`). BTWB has no sandbox/staging environment, so anything about BTWB's real markup or endpoints is still verified by hand against a real logged-in session (see `src/btwb-client.js`'s comments for which templates/workout types have actually been tested). If you open a PR, say how you verified it. CI (GitHub Actions) runs `node --check` and `npm test` on every PR.
- **Endpoints can change without notice.** If something breaks, the most useful bug report is the actual request BTWB's own web app makes for that action (Network tab → request URL, method, and body), not just "it stopped working."
- **Keep the Privacy: Only Me default.** `log_workout` and `log_rounds_workout` hardcode `privacy: onlyme` on purpose - see the README's Privacy section. Please don't add a parameter that overrides it.

## Setup

```bash
npm install
```

You'll need your own BTWB session cookie to test against a real account - see the README's Setup section.

## Style

Plain Node.js/ESM, no build step, no framework beyond `@modelcontextprotocol/sdk`. Match the existing style in `src/btwb-client.js` and `src/index.js` rather than introducing new dependencies or patterns for a small change.
