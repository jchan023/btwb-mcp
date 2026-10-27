# btwb-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-server-blue.svg)](https://modelcontextprotocol.io)

An unofficial [MCP](https://modelcontextprotocol.io) server that lets an LLM search BTWB's movement library, log CrossFit/weightlifting/gymnastics results, and pull your full training history for [Beyond the Whiteboard](https://beyondthewhiteboard.com) (BTWB) - straight from a chat, no copy-pasting between apps.

BTWB has no public API. This server calls the same internal JSON/form endpoints the BTWB web app itself uses, found by inspecting its network traffic. It authenticates with a copied browser session cookie rather than a real API key.

**This is unofficial and unsupported by BTWB.** It can break if they change their app, and your session cookie will periodically expire and need refreshing. Use it for personal automation only.

## Disclaimer

This project calls BTWB's internal, undocumented endpoints rather than a published API, using your own logged-in session cookie in place of an API key. It isn't affiliated with, endorsed by, or supported by BTWB, LLC. Using it may be subject to BTWB's own Terms of Service - review those and use this at your own discretion and risk. Provided as-is, with no warranty (see [LICENSE](LICENSE)).

## Tools

- **`search_movement(term)`** - search BTWB's movement library, returns `{id, name, modality, posting_trait}` matches.
- **`log_workout(movementId, movementName, reps, weight, weightUnit, performedDate, notes)`** - logs a single-movement result (e.g. a 1RM). **Always posts with Privacy: Only Me** - this is hardcoded in `src/btwb-client.js` and is not an exposed parameter, on purpose.
- **`log_rounds_workout(workoutId, workoutSlug, memberId, sections, totalTimeSeconds, performedDate, rxd, notes, trackEventId)`** - logs a multi-movement "rounds" result (e.g. a For Time WOD with several movements per round). Only "For Time" / total-time scoring is supported. **Always posts with Privacy: Only Me**, same as `log_workout`.
- **`log_weigh_in(weight, weighedInDate, hour, minute, percentBodyFat, notes)`** - logs a body-weight entry to BTWB's Weigh-Ins tracker (the dedicated weigh-in feature, not the "Weigh In" movement). Re-submits the height already stored on your BTWB profile (in Imperial mode BTWB reads it from the form's separate feet/inches fields, so those are sent too - without them every weigh-in fails with "Height must be greater than 0"). **No per-entry privacy** - BTWB's weigh-in form has no privacy field, so visibility follows your BTWB account settings, same as entering one by hand.
- **`get_weigh_ins(days)`** - reads your Weigh-Ins tracker: each entry's weight, BTWB's change vs. the previous entry, and timestamp, newest first. Optionally limited to the last N days.
- **`get_track_events(date, track)`** - lists the track events (class programming, personal tracks, ...) on one day of your whiteboard calendar, with each workout event's `trackEventId`, `workoutId` and `workoutSlug`. Events that already have a result come back as `logged` with their `sessionId`. Optional `track` name filter (e.g. `"class"`).
- **`log_sets_workout(workoutId, workoutSlug, sets, performedDate, rxd, notes, trackEventId)`** - logs a set-by-set lifting result (a `weightlifting/sets` or `single/emom` workout, e.g. "Bench Press : 3 @ 80%, ... 2 @ 85%") against that prescribed workout, one actual weight per prescribed set, optionally linked to a track event. The performed date can differ from the track event's day. **Always posted with Privacy: Only Me.**
- **`log_amrap_workout(workoutId, workoutSlug, rounds, extraReps, performedDate, rxd, loads, notes, trackEventId)`** - logs a finished AMRAP (completed rounds + reps into the next round, filled across movements in prescription order) so BTWB stores a real AMRAP score. `loads` overrides load by position for scaled results. **Always posted with Privacy: Only Me.**
- **`log_for_time_workout(workoutId, workoutSlug, totalTimeSeconds, performedDate, rxd, loads, notes, trackEventId)`** - logs a finished For Time result (with or without a time cap) against that prescribed workout, e.g. a class track's chipper, optionally linked to a track event. `loads` overrides a movement's load by position for scaled results. Capped (unfinished) results aren't supported yet. **Always posted with Privacy: Only Me.**
- **`get_movement_history(memberId, movementId, movementSlug, days)`** - pulls the full logged history for a movement over a date range: every individual set (date, reps, weight), not just PRs, plus a computed "Potential Max" trend line. `memberId` is optional and defaults to the signed-in member.
- **`get_member_id()`** - returns the signed-in member's own numeric member ID, read from the "Analyze Dashboard" link in BTWB's navigation menu.
- **`get_workout_session(sessionId)`** - fetches details of an already-logged result by its session ID.
- **`delete_workout_session(sessionId)`** - permanently deletes an already-logged result by its session ID. No undo.
- **`refresh_session_cookie()`** - manually re-authenticates and replaces the stored session cookie. Every other tool already does this automatically on an expired session (see "Automatic cookie refresh" below) - this is mainly for testing your setup or forcing an early refresh.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get your session cookie into Keychain

1. Log into [beyondthewhiteboard.com](https://beyondthewhiteboard.com) in your browser.
2. Open DevTools → Network tab, reload the page.
3. Click any request to `beyondthewhiteboard.com`.
4. Copy the full value of the `Cookie` request header.
5. Store it directly in Keychain (run this yourself in a terminal - never paste your cookie into a chat/AI session):

   ```bash
   security add-generic-password -a "$USER" -s "btwb-session-cookie" -A -U -w "your_cookie_here"
   ```

This cookie is tied to your login session. If tools start failing with a CSRF/session error, it has expired - repeat these steps for a fresh one, or set up automatic refresh below so you never have to.

### 3. Register with Claude Code

Add to your `.mcp.json` (project-level or global):

```json
{
  "mcpServers": {
    "btwb": {
      "command": "node",
      "args": ["/absolute/path/to/btwb-mcp/src/index.js"]
    }
  }
}
```

No `env` block needed - the cookie lives in Keychain, not in config. Or via the CLI:

```bash
claude mcp add btwb -- node /absolute/path/to/btwb-mcp/src/index.js
```

### 4. (Optional) Enable automatic cookie refresh

By default, when your session cookie expires you refresh it by hand (repeat step 2). Optionally, you can let the server re-authenticate for you automatically whenever it detects an expired session - every tool call transparently retries once through a fresh login if needed, so you never have to touch DevTools again. This has been verified working end-to-end (login → fresh cookie → Keychain update → live authenticated request).

This requires storing your actual BTWB **password** (not just a session cookie) in Keychain. Weigh that before opting in - see the caveats below.

1. Store your BTWB password in Keychain (run this yourself in a terminal - never paste your password into a chat/AI session):

   ```bash
   security add-generic-password -a "$USER" -s "btwb-password" -A -w
   ```

   `-w` with nothing after it makes `security` prompt for the password on a separate line with hidden input - it's never part of the command itself, so it's never echoed and never saved to shell history. (Prefer a GUI? Keychain Access.app → File → New Password Item → name `btwb-password`, account = your Mac username, works identically.)

   Note: `-a "$USER"` is just the Keychain lookup key the code uses internally (your Mac account name) - it isn't your BTWB login and doesn't need to match your email.

   **Running this on a Claude cloud session (Claude Code on the web, a remote/cloud environment) instead of your own Mac?** Those run in a Linux container with no Keychain at all, so `security` can't work there. Set the `BTWB_PASSWORD` env var instead - the server tries Keychain first and falls back to it automatically. Since a password doesn't go stale the way a copied cookie does, this doesn't reintroduce the "stale cookie in an env var" problem Keychain-only storage was chosen to avoid; the cookie itself still only ever lives in memory for that process, never in an env var or on disk.

2. Set `BTWB_EMAIL` to your BTWB login email (this one isn't sensitive on its own, unlike the password). Since GUI-launched MCP clients don't source your shell profile, the reliable place is your `.mcp.json`'s `env` block, alongside the cookie:

   ```json
   {
     "mcpServers": {
       "btwb": {
         "command": "node",
         "args": ["/absolute/path/to/btwb-mcp/src/index.js"],
         "env": {
           "BTWB_EMAIL": "you@example.com"
         }
       }
     }
   }
   ```

   (`.env` or `export BTWB_EMAIL=...` also work for terminal-launched sessions. On a Claude cloud session, add `BTWB_PASSWORD` as an environment secret rather than committing it to `.mcp.json`.)

3. Restart the MCP server. `refresh_session_cookie` (or any other tool, automatically, whenever it detects an expired session) will now sign in with those credentials and overwrite the stored session cookie.

**Caveats:**
- This stores a second, more sensitive secret (your actual login password) in Keychain (or, on a Claude cloud session, in `BTWB_PASSWORD`), not just a session token.
- It depends on BTWB's `/signin` → `/session` login form staying script-friendly. If BTWB ever adds a CAPTCHA or 2FA step, automatic refresh will start failing (with a clear error, not silently) and you'll fall back to the manual method.
- On a Claude cloud session, the refreshed cookie is cached in memory only and re-fetched on every process restart (one extra login) - it can't be persisted the way it is on macOS.
- Don't want this? Just skip this step - everything else works exactly as before, you'll just refresh the cookie by hand when it expires.

## Privacy

Every workout result this server logs is posted with **Privacy: Only Me**, hardcoded in the client, not passed as a parameter. The one exception is `log_weigh_in`: BTWB's Weigh-Ins form has no privacy field at all, so weigh-ins follow your BTWB account settings. If you ever need a differently-scoped post, do it by hand in the BTWB app rather than changing this server's default.

## How the endpoints were found

Documented in commit history / session notes: found by watching Network tab traffic in a real logged-in browser session while performing each action (searching a movement, submitting the "Log Result" form, viewing a movement's PR page), then reading the resulting request URLs and the log form's actual field names directly out of the page DOM.

- Search: `GET /exercises/autocomplete_name.json?posting_trait=true&term={term}`
- Log (single movement): `POST /workouts/logger` (form-encoded, CSRF-protected, `workout_session[definition]` JSON)
- Log (multi-movement/rounds): `POST /workouts/{workoutId}-{slug}/workout_sessions` (form-encoded, CSRF-protected, `workout_session[uiobject]` JSON - a different field name and shape than the single-movement flow)
- Weigh-in: `GET /members/{memberId}/weigh_ins/new` (CSRF token + stored height) then `POST /weigh_ins` (form-encoded: `weigh_in[weighed_in_at(1i-5i)]` date/hour/minute parts, `weigh_in[weight]`, `weigh_in[height]`, `weigh_in[metric]`, optional `weigh_in[percent_body_fat]`, `weigh_in[notes]`)
- History: `GET /members/{memberId}/movements/{movementId}-{slug}/vmax?d={seconds}`
- Single session detail: `GET /workout_sessions/{id}` (HTML scrape - no JSON endpoint)
- Delete: `DELETE /workout_sessions/{id}` (CSRF-protected, same endpoint as the app's own "Delete" UJS links)
- Sign in (for automatic cookie refresh): `GET /signin` (pre-login session cookie + CSRF token) then `POST /session` (form-encoded: `login`, `password`, `authenticity_token`, `remember_me`)

## Contributing

Bug reports and PRs are welcome - see [CONTRIBUTING.md](CONTRIBUTING.md) for how this project is tested (there's no automated test suite) and what to include in a report.

## Security

Found a security issue (e.g. a way this could leak your session cookie)? See [SECURITY.md](SECURITY.md) for how to report it privately.

## License

[MIT](LICENSE)
