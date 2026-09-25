// Unofficial client for beyondthewhiteboard.com.
// There is no public BTWB API - this calls the same internal endpoints the
// BTWB web app itself uses, authenticated with a copied browser session
// cookie rather than a real API key. It can break if BTWB changes their app,
// and the cookie will need refreshing whenever the session expires.

import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

const BASE_URL = "https://beyondthewhiteboard.com";
const KEYCHAIN_SERVICE = "btwb-session-cookie";
const PASSWORD_KEYCHAIN_SERVICE = "btwb-password";

let cachedCookie;
let keychainError;

// Merges a response's Set-Cookie headers into a "name=value; name2=value2"
// Cookie string, replacing same-named cookies. BTWB sets more than one cookie
// at once (remember_me_token AND _btwb_session_id at sign-in, and a rotated
// _btwb_session_id on page loads), and the CSRF token on a page is tied to the
// _btwb_session_id sent with it - keeping only the first cookie makes every
// write (log/delete) fail with HTTP 422 while reads still work.
function mergeSetCookies(cookieString, headers) {
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") || "").split(/,(?=\s*[^;=\s]+=)/);

  const jar = new Map();
  for (const pair of (cookieString || "").split(";")) {
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  for (const setCookie of setCookies) {
    const pair = setCookie.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function readSecretFromKeychain(service) {
  try {
    // process.env.USER is not reliable here - GUI-launched processes (like
    // the Claude desktop app spawning this server) often don't have it set.
    // os.userInfo() asks the OS directly instead.
    const account = userInfo().username;
    return execFileSync(
      "security",
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      { encoding: "utf8" }
    ).trim();
  } catch (err) {
    if (service === KEYCHAIN_SERVICE) {
      keychainError = err.stderr ? err.stderr.toString().trim() : err.message;
    }
    return undefined;
  }
}

function readFromKeychain() {
  return readSecretFromKeychain(KEYCHAIN_SERVICE);
}

// Keychain is the preferred source of truth for both the live cookie and the
// login password - it's what refreshSessionCookie() keeps current automatically
// on macOS. BTWB_PASSWORD is a fallback for a Claude cloud session (a Linux
// container with no Keychain): unlike a cookie, a password doesn't go stale,
// so holding it in an env var doesn't reintroduce the "stale copied cookie"
// problem the Keychain-only design was chosen to avoid.
function readPassword() {
  return readSecretFromKeychain(PASSWORD_KEYCHAIN_SERVICE) || process.env.BTWB_PASSWORD;
}

async function getCookie() {
  if (cachedCookie) return cachedCookie;

  const cookie = readFromKeychain();
  if (cookie) {
    cachedCookie = cookie;
    return cachedCookie;
  }

  // No stored cookie - either nothing's been saved yet, or this host has no
  // Keychain at all (readFromKeychain() fails the same way either way). If
  // login credentials are configured, get a fresh cookie automatically
  // instead of requiring a manual DevTools copy on every restart.
  if (process.env.BTWB_EMAIL && readPassword()) {
    await refreshSessionCookie();
    return cachedCookie;
  }

  throw new Error(
    `No BTWB session cookie found in Keychain (service: ${KEYCHAIN_SERVICE}). ` +
      "Either set BTWB_EMAIL plus a password (Keychain on macOS, or the BTWB_PASSWORD " +
      "env var on hosts without Keychain) so refresh_session_cookie can log in " +
      "automatically, or copy one manually from DevTools and store it - see README.md." +
      (keychainError ? ` [Keychain error: ${keychainError}]` : "")
  );
}

// Logs in with BTWB_EMAIL + a password (Keychain on macOS, or BTWB_PASSWORD
// elsewhere) and replaces the stored session cookie with a fresh one - the
// same request beyondthewhiteboard.com's own /signin form makes (GET /signin
// for a pre-login session cookie + CSRF token, then POST /session with
// credentials). Optional: only works if both credentials are configured (see
// README "Automatic cookie refresh"); without them this throws and callers
// fall back to the "copy a fresh cookie by hand" error path.
export async function refreshSessionCookie() {
  const email = process.env.BTWB_EMAIL;
  const password = readPassword();
  if (!email || !password) {
    throw new Error(
      "Can't auto-refresh the BTWB session: set BTWB_EMAIL and a password - store the " +
        `password in Keychain (service: ${PASSWORD_KEYCHAIN_SERVICE}) on macOS, or set the ` +
        "BTWB_PASSWORD env var on hosts without Keychain - see README " +
        '"Automatic cookie refresh". Otherwise copy a fresh Cookie header from your ' +
        "browser by hand instead."
    );
  }

  const signinRes = await fetch(`${BASE_URL}/signin`);
  const signinCookie = mergeSetCookies("", signinRes.headers);
  const signinHtml = await signinRes.text();
  const tokenMatch = signinHtml.match(/name="authenticity_token" value="([^"]+)"/);
  if (!tokenMatch) {
    throw new Error("Could not find a CSRF token on the BTWB sign-in page - it may have changed.");
  }

  const body = new URLSearchParams({
    authenticity_token: tokenMatch[1],
    login: email,
    password,
    remember_me: "1",
    commit: "Sign In",
  });

  const loginRes = await fetch(`${BASE_URL}/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(signinCookie ? { Cookie: signinCookie } : {}),
    },
    body,
    redirect: "manual",
  });

  if (![302, 303].includes(loginRes.status)) {
    throw new Error(
      `BTWB sign-in failed: HTTP ${loginRes.status}. Check BTWB_EMAIL and the password ` +
        `(Keychain service: ${PASSWORD_KEYCHAIN_SERVICE}, or BTWB_PASSWORD) are correct - ` +
        "this also fails if BTWB ever adds a CAPTCHA/2FA step to sign-in."
    );
  }

  if (!loginRes.headers.get("set-cookie")) {
    throw new Error("BTWB sign-in succeeded but didn't return a new session cookie.");
  }
  const freshCookie = mergeSetCookies(signinCookie, loginRes.headers);

  try {
    execFileSync("security", [
      "add-generic-password",
      "-a", userInfo().username,
      "-s", KEYCHAIN_SERVICE,
      "-w", freshCookie,
      "-A",
      "-U",
    ]);
  } catch {
    // No Keychain on this host (e.g. a Claude cloud session) - the refreshed
    // cookie still lives in the in-memory cache below for this process's
    // lifetime, it just isn't persisted across restarts. Expected outside
    // macOS, not an error.
  }

  cachedCookie = freshCookie;
  return { success: true };
}

async function fetchWhiteboardHtml() {
  const res = await fetch(`${BASE_URL}/whiteboard`, {
    headers: { Cookie: await getCookie() },
  });
  if (!res.ok) {
    throw new Error(`Failed to load page for CSRF token: HTTP ${res.status}`);
  }
  // Keep any rotated session cookie so the write that follows is sent with
  // the same session this page's CSRF token belongs to.
  cachedCookie = mergeSetCookies(cachedCookie, res.headers);
  return res.text();
}

async function getCsrfToken() {
  let html = await fetchWhiteboardHtml();
  let match = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  if (!match) {
    // Missing csrf-token usually means the session cookie has expired and
    // BTWB served a logged-out page instead - try one automatic re-login
    // (if configured) before falling back to the manual-copy error.
    await refreshSessionCookie();
    html = await fetchWhiteboardHtml();
    match = html.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (!match) {
      throw new Error(
        "Could not find a CSRF token on the page even after refreshing the session - " +
          "BTWB's login page may have changed."
      );
    }
  }
  return match[1];
}

// The signed-in member's own ID, read from the "Analyze Dashboard" link in
// BTWB's navigation menu (/analyze/members/{id}) - that link always points at
// the current user, unlike other /members/{id} links on the whiteboard, which
// can belong to gym-mates. Cached for the process's lifetime.
let cachedMemberId;

export async function getMemberId() {
  if (cachedMemberId) return cachedMemberId;

  const pattern = /href="\/analyze\/members\/(\d+)"/;
  let match = (await fetchWhiteboardHtml()).match(pattern);
  if (!match) {
    // Same expired-session fallback as getCsrfToken().
    await refreshSessionCookie();
    match = (await fetchWhiteboardHtml()).match(pattern);
    if (!match) {
      throw new Error(
        "Could not find your member ID on the BTWB whiteboard page even after " +
          "refreshing the session - BTWB's navigation markup may have changed."
      );
    }
  }
  cachedMemberId = Number(match[1]);
  return cachedMemberId;
}

export async function searchMovement(term) {
  const res = await fetch(
    `${BASE_URL}/exercises/autocomplete_name.json?posting_trait=true&term=${encodeURIComponent(term)}`,
    { headers: { Cookie: await getCookie() } }
  );
  if (!res.ok) {
    throw new Error(`BTWB movement search failed: HTTP ${res.status}`);
  }
  return res.json();
}

export async function logWorkout({
  movementId,
  movementName,
  reps,
  weight,
  weightUnit = "lbs",
  performedDate,
  notes = "",
}) {
  const csrfToken = await getCsrfToken();
  const cookie = await getCookie();

  const definition = {
    type: "workoutSession",
    execution: {
      type: "weightlifting/sets",
      scoring: "totalWeight",
      result: { totalWeight: { value: weight, unit: weightUnit } },
    },
    contents: [
      {
        type: "movement",
        movementName,
        movementId,
        reps: { value: reps, unit: "reps" },
        inputs: { weight: { value: weight, unit: weightUnit } },
      },
    ],
  };

  const body = new URLSearchParams({
    authenticity_token: csrfToken,
    "workout_session[definition]": JSON.stringify(definition),
    "workout_session[prescribed]": "true",
    "workout_session[performedDate]": performedDate,
    "workout_session[notes]": notes,
    // Hard rule, not a default: every post through this server is private.
    // Do not wire a parameter that can override this - see README "Privacy".
    "workout_session[privacy]": "onlyme",
    commit: "Log Result",
  });

  const res = await fetch(`${BASE_URL}/workouts/logger`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRF-Token": csrfToken,
    },
    body,
    redirect: "manual",
  });

  // Rails redirects (302/303) to the new workout_session on success.
  if (![302, 303].includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `BTWB log_workout failed: HTTP ${res.status}. ${text.slice(0, 300)}`
    );
  }

  return {
    success: true,
    privacy: "onlyme",
    redirectedTo: res.headers.get("location"),
  };
}

// Logs a multi-movement "rounds" result (e.g. a "For Time" WOD with several
// movements per round), as opposed to logWorkout's single-movement schema.
// Reverse-engineered by filling out a real BTWB "Log Result" form for a
// named/benchmark workout and extracting its actual POST payload - BTWB uses
// a totally different field name and JSON shape here ("uiobject", execution
// type "bookends") than the single-movement flow ("definition", execution
// type "weightlifting/sets"). Only the "For Time" / totalTime-scoring case
// has been tested; other scoring types (e.g. AMRAP/totalReps) may need a
// different execution.type/scoring and haven't been verified.
export async function logRoundsWorkout({
  workoutId,
  workoutSlug,
  memberId,
  sections,
  totalTimeSeconds,
  performedDate,
  rxd,
  notes = "",
  trackEventId,
}) {
  const csrfToken = await getCsrfToken();
  const cookie = await getCookie();

  const uiobject = {
    type: "workoutSession",
    execution: {
      type: "bookends",
      inputs: { time: { value: totalTimeSeconds, unit: "seconds" } },
      scoring: "totalTime",
      result: { totalTime: { value: totalTimeSeconds, unit: "seconds" } },
    },
    contents: sections.map(({ rounds, movements }) => ({
      type: "section",
      rounds,
      contents: movements.map(({ movementName, movementId, measures }) => ({
        type: "movement",
        movementName,
        movementId,
        ...measures,
      })),
    })),
  };

  // The form's hidden "performedOn" field carries a human-readable date
  // alongside session_date - included for parity with what the real form
  // sends, since it's unclear whether the server actually depends on it.
  const performedOn = new Date(`${performedDate}T00:00:00`).toLocaleDateString(
    "en-US",
    { weekday: "long", month: "long", day: "numeric", year: "numeric" }
  );

  const body = new URLSearchParams({
    authenticity_token: csrfToken,
    "workout_session[uiobject]": JSON.stringify(uiobject),
    "workout_session[member_id]": String(memberId),
    "workout_session[rxd]": String(rxd),
    "workout_session[session_date]": performedDate,
    performedOn,
    "workout_session[notes_plain_text]": notes,
    // Hard rule, not a default: every post through this server is private.
    // Do not wire a parameter that can override this - see README "Privacy".
    "workout_session[privacy]": "onlyme",
  });
  if (trackEventId) {
    body.append("track_event_ids[]", String(trackEventId));
  }

  const res = await fetch(
    `${BASE_URL}/workouts/${workoutId}-${workoutSlug}/workout_sessions`,
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRF-Token": csrfToken,
      },
      body,
      redirect: "manual",
    }
  );

  if (![302, 303].includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `BTWB log_rounds_workout failed: HTTP ${res.status}. ${text.slice(0, 300)}`
    );
  }

  return {
    success: true,
    privacy: "onlyme",
    redirectedTo: res.headers.get("location"),
  };
}

// Lists the scheduled track events (class programming, personal tracks, etc.)
// on one day of the member's whiteboard calendar - the ids log_sets_workout /
// log_rounds_workout need to link a result to a track. Scraped from the
// whiteboard week view (/members/{id}/whiteboard/day?d=...), which renders the
// whole week around that date; only the requested day's box is read. For
// workout events, each event's details popup is also fetched for the
// underlying workout's id and slug. `track` optionally filters by a
// case-insensitive substring of the track name (e.g. "class").
export async function getTrackEvents({ date, track } = {}) {
  const memberId = await getMemberId();
  const html = await fetchPageHtml(`/members/${memberId}/whiteboard/day?d=${date}`);

  const trackNames = {};
  for (const [, key, name] of html.matchAll(
    /<li data-track-events="(track_\d+)"[^>]*>\s*<span[^>]*><\/span>\s*([^<]+?)\s*<\/li>/g
  )) {
    trackNames[key] = decodeHtmlEntities(name);
  }

  const dayStart = html.indexOf(`whiteboard/day?d=${date}"`);
  if (dayStart < 0) {
    throw new Error(`No ${date} box found on the BTWB whiteboard calendar.`);
  }
  const nextDay = html.indexOf('class="box box-day', dayStart);
  const dayHtml = html.slice(dayStart, nextDay < 0 ? undefined : nextDay);

  // Scheduled events render as track_event items; once a result has been
  // logged against one, BTWB swaps it for a workout_session item instead.
  const events = [];
  const itemPattern =
    /<li class="\w+ (track_\d+)">\s*<div class="view-task-details (track_event|workout_session)"\s*data-task="(\w+)"\s*data-uri="\/tasks\/members\/\d+\/(?:track_events|workout_sessions)\/(\d+)">([\s\S]*?)<\/li>/g;
  for (const [, trackKey, itemType, kind, id, body] of dayHtml.matchAll(itemPattern)) {
    const trackName = trackNames[trackKey] || trackKey;
    if (track && !trackName.toLowerCase().includes(track.toLowerCase())) continue;
    const title = decodeHtmlEntities(body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
    events.push(
      itemType === "workout_session"
        ? { trackName, kind: "logged", sessionId: Number(id), title }
        : { trackEventId: Number(id), trackName, kind, title }
    );
  }

  for (const event of events.filter((e) => e.kind === "workout")) {
    const details = await fetchPageHtml(
      `/tasks/members/${memberId}/track_events/${event.trackEventId}`
    ).catch(() => "");
    const workout = details.match(/href="\/workouts\/(\d+)-([^"/?]+)"/);
    if (workout) {
      event.workoutId = Number(workout[1]);
      event.workoutSlug = workout[2];
    }
  }

  return { date, events };
}

// Loads a prescribed workout's own "Log Result" page for its CSRF token and
// prescription (the `var uiobject` BTWB's logger is seeded with) - the
// starting point for logging a result against that exact workout.
async function loadPrescribedWorkout(workoutId, workoutSlug, performedDate) {
  const html = await fetchPageHtml(
    `/workouts/${workoutId}-${workoutSlug}/workout_sessions/new?d=${performedDate}`
  );
  const csrfToken = html.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1];
  const prescriptionJson = html.match(/var uiobject =\s*(\{[\s\S]*?\})\s*;/)?.[1];
  if (!csrfToken || !prescriptionJson) {
    throw new Error(
      "Could not read the workout's Log Result form (CSRF token or prescription) - " +
        "check workoutId/workoutSlug, or BTWB's logger page may have changed."
    );
  }
  return { csrfToken, workout: JSON.parse(prescriptionJson) };
}

// Posts a workout_session for a prescribed workout - the same form fields
// BTWB's "Log Result" page submits - optionally linked to a track event.
async function postPrescribedSession({
  toolName,
  workoutId,
  workoutSlug,
  csrfToken,
  uiobject,
  performedDate,
  rxd,
  notes,
  trackEventId,
}) {
  const memberId = await getMemberId();
  const performedOn = new Date(`${performedDate}T00:00:00`).toLocaleDateString(
    "en-US",
    { weekday: "long", month: "long", day: "numeric", year: "numeric" }
  );

  const body = new URLSearchParams({
    authenticity_token: csrfToken,
    "workout_session[uiobject]": JSON.stringify(uiobject),
    "workout_session[member_id]": String(memberId),
    "workout_session[rxd]": String(rxd),
    "workout_session[session_date]": performedDate,
    performedOn,
    "workout_session[notes_plain_text]": notes,
    // Hard rule, not a default: every post through this server is private.
    // Do not wire a parameter that can override this - see README "Privacy".
    "workout_session[privacy]": "onlyme",
    commit: "Log Result",
  });
  if (trackEventId) {
    body.append("track_event_ids[]", String(trackEventId));
  }

  const res = await fetch(`${BASE_URL}/workouts/${workoutId}-${workoutSlug}/workout_sessions`, {
    method: "POST",
    headers: {
      Cookie: cachedCookie,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRF-Token": csrfToken,
    },
    body,
    redirect: "manual",
  });

  if (![302, 303].includes(res.status)) {
    const text = await res.text().catch(() => "");
    const errors = [...text.matchAll(/<li>([^<]+)<\/li>/g)]
      .map((m) => m[1])
      .filter((t) => /must|can't|invalid|blank/i.test(t));
    throw new Error(
      `BTWB ${toolName} failed: HTTP ${res.status}.` +
        (errors.length ? ` ${errors.join("; ")}` : ` ${text.slice(0, 300)}`)
    );
  }

  return {
    success: true,
    privacy: "onlyme",
    redirectedTo: res.headers.get("location"),
  };
}

// Logs a set-by-set lifting result (e.g. a class track's "Bench Press : 3 @
// 80%, 3 @ 80%, ... 2 @ 85%" strength piece) against a specific prescribed
// workout, optionally linked to a track event - unlike logWorkout, which
// always posts a fresh single-movement "N Rep Max" result. Each prescribed
// set keeps its movement, reps and prescribed load (e.g. 80% of 1RM) and gets
// the actual weight lifted as its input - the same shape BTWB's
// weightlifting/sets logger posts. Scoring stays "completed" as prescribed;
// only percentage/pick-load weightlifting/sets workouts have been tested.
export async function logSetsWorkout({
  workoutId,
  workoutSlug,
  sets,
  performedDate,
  rxd = true,
  notes = "",
  trackEventId,
}) {
  const { csrfToken, workout } = await loadPrescribedWorkout(workoutId, workoutSlug, performedDate);
  const prescription = workout.prescription || {};
  if (prescription.type !== "weightlifting/sets") {
    throw new Error(
      `log_sets_workout only handles weightlifting/sets workouts; this one is "${prescription.type}".`
    );
  }
  const prescribedSets = (workout.contents || []).filter((c) => c.type === "movement");
  if (prescribedSets.length !== sets.length) {
    throw new Error(
      `This workout prescribes ${prescribedSets.length} sets but ${sets.length} were given - ` +
        "pass one {weight} (and optional reps) per prescribed set, in order."
    );
  }

  const contents = prescribedSets.map((set, i) => {
    const { weight, weightUnit = "lbs", reps } = sets[i];
    const { inputs, ...rest } = set;
    return {
      ...rest,
      ...(reps != null ? { reps: { value: reps, unit: "reps" } } : {}),
      inputs: { weight: { value: weight, unit: weightUnit } },
    };
  });

  const { type, ...executionFields } = prescription;
  const uiobject = {
    type: "workoutSession",
    execution: { type, ...executionFields, scoring: prescription.scoring || "completed" },
    contents,
  };

  return postPrescribedSession({
    toolName: "log_sets_workout",
    workoutId,
    workoutSlug,
    csrfToken,
    uiobject,
    performedDate,
    rxd,
    notes,
    trackEventId,
  });
}

// Logs a finished "For Time" result (with or without a time cap) against a
// specific prescribed workout, optionally linked to a track event - e.g. a
// class track's chipper. The workout's movements, reps, distances and loads
// come from its prescription; `loads` optionally overrides a movement's load
// by position (for a scaled result, e.g. lighter kettlebells), null keeps the
// prescribed one. Mirrors BTWB's forTime/timeCap logger for the "finished
// under the cap" case (scoring totalTime); a capped result (reps at the cap)
// isn't handled.
export async function logForTimeWorkout({
  workoutId,
  workoutSlug,
  totalTimeSeconds,
  performedDate,
  rxd = true,
  loads = [],
  notes = "",
  trackEventId,
}) {
  const { csrfToken, workout } = await loadPrescribedWorkout(workoutId, workoutSlug, performedDate);
  const prescription = workout.prescription || {};
  if (!/^forTime/.test(prescription.type || "")) {
    throw new Error(
      `log_for_time_workout only handles For Time workouts; this one is "${prescription.type}".`
    );
  }
  const capSeconds = prescription.timeCap?.time?.value;
  if (capSeconds && totalTimeSeconds > capSeconds) {
    throw new Error(
      `${totalTimeSeconds}s is over the ${capSeconds}s time cap - capped results aren't supported.`
    );
  }

  const contents = (workout.contents || []).map((item, i) => {
    if (item.type !== "movement") return item;
    const { inputs, ...rest } = item;
    const load = loads[i];
    return {
      ...rest,
      ...(load ? { weight: { value: load.weight, unit: load.weightUnit || "lbs" } } : {}),
      ...(Array.isArray(inputs) && inputs.includes("reps") && item.reps
        ? { inputs: { reps: item.reps } }
        : {}),
    };
  });

  const time = { value: totalTimeSeconds, unit: "seconds" };
  const uiobject = {
    type: "workoutSession",
    execution: {
      type: prescription.type,
      ...(prescription.timeCap ? { timeCap: prescription.timeCap } : {}),
      inputs: { time },
      scoring: "totalTime",
      result: { totalTime: time },
    },
    contents,
  };

  return postPrescribedSession({
    toolName: "log_for_time_workout",
    workoutId,
    workoutSlug,
    csrfToken,
    uiobject,
    performedDate,
    rxd,
    notes,
    trackEventId,
  });
}

// Logs a body-weight entry to BTWB's Weigh-Ins tracker (/members/{id}/weigh_ins),
// the same POST its "New Weigh In" form makes - a separate feature from the
// "Weigh In" movement, which would go through logWorkout instead. Unlike the
// workout logger, this form has NO per-entry privacy field: visibility follows
// the member's BTWB account settings, same as a weigh-in entered by hand.
// The form is loaded first (rather than the whiteboard) because it carries both
// the CSRF token and the member's stored height, which the real form re-submits
// with every weigh-in - sending it back unchanged keeps BTWB's BMI/body-fat math
// from being fed a missing height.
export async function logWeighIn({
  weight,
  weighedInDate,
  hour = 7,
  minute = 0,
  percentBodyFat,
  notes = "",
}) {
  const memberId = await getMemberId();
  const formUrl = `${BASE_URL}/members/${memberId}/weigh_ins/new`;

  let res = await fetch(formUrl, { headers: { Cookie: await getCookie() } });
  cachedCookie = mergeSetCookies(cachedCookie, res.headers);
  let html = await res.text();
  let tokenMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  if (!tokenMatch) {
    // Same expired-session fallback as getCsrfToken().
    await refreshSessionCookie();
    res = await fetch(formUrl, { headers: { Cookie: await getCookie() } });
    cachedCookie = mergeSetCookies(cachedCookie, res.headers);
    html = await res.text();
    tokenMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (!tokenMatch) {
      throw new Error(
        "Could not find a CSRF token on the BTWB New Weigh In page even after " +
          "refreshing the session - the page may have changed."
      );
    }
  }
  const csrfToken = tokenMatch[1];
  const heightMatch = html.match(/value="([\d.]+)"[^>]*name="weigh_in\[height\]"/);
  // In Imperial mode BTWB rebuilds height from these two separate selects
  // (feet/inches, outside the weigh_in[...] namespace) and ignores
  // weigh_in[height] - without them every weigh-in fails validation with
  // "Height must be greater than 0" (the form just re-renders with HTTP 200).
  const selectedOption = (name) =>
    html
      .match(new RegExp(`<select name="${name}"[\\s\\S]*?</select>`))?.[0]
      .match(/<option selected="selected" value="(\d+)"/)?.[1];
  const feet = selectedOption("feet");
  const inches = selectedOption("inches");
  const metricMatch = html.match(/<option selected="selected" value="(true|false)">(?:Imperial|Metric)/);

  const [year, month, day] = weighedInDate.split("-").map(Number);
  // The form only offers :00/:15/:30/:45 - snap to the nearest option below.
  const snappedMinute = Math.floor(minute / 15) * 15;

  const body = new URLSearchParams({
    authenticity_token: csrfToken,
    "weigh_in[member_id]": String(memberId),
    "weigh_in[weighed_in_at(1i)]": String(year),
    "weigh_in[weighed_in_at(2i)]": String(month),
    "weigh_in[weighed_in_at(3i)]": String(day),
    "weigh_in[weighed_in_at(4i)]": String(hour).padStart(2, "0"),
    "weigh_in[weighed_in_at(5i)]": String(snappedMinute).padStart(2, "0"),
    "weigh_in[metric]": metricMatch ? metricMatch[1] : "false",
    "weigh_in[weight]": String(weight),
    "weigh_in[notes]": notes,
    commit: "Create Weigh In",
  });
  if (heightMatch) body.set("weigh_in[height]", heightMatch[1]);
  if (feet) body.set("feet", feet);
  if (inches) body.set("inches", inches);
  if (percentBodyFat != null) {
    body.set("weigh_in[percent_body_fat]", String(percentBodyFat));
  }

  res = await fetch(`${BASE_URL}/weigh_ins`, {
    method: "POST",
    headers: {
      Cookie: cachedCookie,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRF-Token": csrfToken,
    },
    body,
    redirect: "manual",
  });

  // Rails redirects (302/303) on success; a 200 means the form re-rendered
  // with validation errors.
  if (![302, 303].includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw new Error(`BTWB log_weigh_in failed: HTTP ${res.status}. ${text.slice(0, 300)}`);
  }

  return { success: true, redirectedTo: res.headers.get("location") };
}

// Reads the member's Weigh-Ins tracker (/members/{id}/weigh_ins). There's no
// JSON endpoint, so this scrapes the page's entry list (id, weight, BTWB's own
// change-vs-previous, and the weighed-in timestamp). Newest first. `days`
// filters to entries within that many days of now.
export async function getWeighIns({ days } = {}) {
  const memberId = await getMemberId();
  const html = await fetchPageHtml(`/members/${memberId}/weigh_ins`);

  const cutoff = days != null ? Date.now() - days * 86400000 : null;
  const entries = [];
  const itemPattern = /<li id="weigh_in_(\d+)" class="weigh-in">([\s\S]*?)<\/li>/g;
  for (const [, id, item] of html.matchAll(itemPattern)) {
    const weight = item.match(/href="\/weigh_ins\/\d+">([\d.]+)\s*(lbs|kg)</);
    const change = item.match(/weigh-ins__value--change">\s*\(([-+]?[\d.]+)/);
    const at = item.match(/datetime="([^"]+)"/);
    if (!weight || !at) continue;
    if (cutoff != null && Date.parse(at[1]) < cutoff) continue;
    entries.push({
      id: Number(id),
      weighedInAt: at[1],
      weight: Number(weight[1]),
      unit: weight[2],
      change: change ? Number(change[1]) : null,
      url: `${BASE_URL}/weigh_ins/${id}`,
    });
  }

  const totalMatch = html.match(/weigh-ins__total-entries">\s*(\d+) Weigh Ins/);
  return {
    memberId,
    totalWeighIns: totalMatch ? Number(totalMatch[1]) : null,
    entries,
  };
}

export async function getMovementHistory({ memberId, movementId, movementSlug, days = 365 }) {
  memberId ??= await getMemberId();
  const seconds = Math.round(days * 86400);
  const res = await fetch(
    `${BASE_URL}/members/${memberId}/movements/${movementId}-${movementSlug}/vmax?d=${seconds}`,
    { headers: { Cookie: await getCookie() } }
  );
  if (!res.ok) {
    throw new Error(`BTWB movement history fetch failed: HTTP ${res.status}`);
  }
  return res.json();
}

// Posts a workout *definition* (a prescription, not a result) to BTWB's
// workout builder - the same request its "Build Workout" wizard submits when
// you press "Next: Confirm & Save". Captured by filling the wizard in and
// reading the POST it makes.
//
// The endpoint is find-OR-create: an identical prescription resolves to the
// workout already in BTWB's library instead of creating a duplicate (building
// "Bench Press, 3 sets of 3" answers "Workout Found: Bench Press : 3-3-3
// (id: 9385)"). That makes it safe to call repeatedly - it won't litter the
// library - and means the id you get back is usually one everyone already
// shares, so results are comparable across the site.
//
// Body is a single `definition` field holding JSON; the CSRF token rides in
// the X-CSRF-Token header, not the body, the same way postPrescribedSession
// sends it.
async function saveWorkoutDefinition({ toolName, prescription, contents, name, description }) {
  const csrfToken = await getCsrfToken();
  const definition = { type: "workout", prescription, contents };

  const res = await fetch(`${BASE_URL}/workouts/builder/save`, {
    method: "POST",
    headers: {
      Cookie: cachedCookie,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRF-Token": csrfToken,
    },
    body: new URLSearchParams({ definition: JSON.stringify(definition) }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`BTWB ${toolName} failed: HTTP ${res.status}. ${text.slice(0, 300)}`);
  }

  // Match found - BTWB resolved the prescription to a workout already in its
  // library and there's nothing to create.
  const found = text.match(/Workout Found:\s*([^<(]+?)\s*\(id:\s*(\d+)\)/);
  if (found) {
    return {
      workoutId: Number(found[2]),
      workoutName: decodeHtmlEntities(found[1].trim()),
      existing: true,
      definition,
    };
  }

  // No match: BTWB answers with the "name it and save" form instead. Its
  // workout[name]/[description] fields come back EMPTY - the real page fills
  // them in client-side from the builder's knockout view model - so a caller
  // has to supply the name itself.
  const createForm = /id="new-workout-form"/.test(text);
  if (!createForm) {
    throw new Error(
      `BTWB ${toolName}: unrecognised builder response. ${text.slice(0, 300)}`
    );
  }
  if (!name) {
    return {
      workoutId: null,
      existing: false,
      created: false,
      needsName: true,
      message:
        "No workout in BTWB's library matches this prescription. Pass `name` " +
        "to create it (BTWB builds the display name in the browser, so it " +
        "can't be derived server-side).",
      definition,
    };
  }

  const formToken = text.match(/name="authenticity_token" value="([^"]+)"/)?.[1] || csrfToken;
  const createRes = await fetch(`${BASE_URL}/workouts`, {
    method: "POST",
    headers: {
      Cookie: cachedCookie,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRF-Token": csrfToken,
    },
    body: new URLSearchParams({
      authenticity_token: formToken,
      "workout[name]": name,
      "workout[description]": description || name,
      "workout[uiobject]": JSON.stringify(definition),
      commit: "Save",
    }),
    redirect: "manual",
  });

  if (![302, 303].includes(createRes.status)) {
    const body = await createRes.text().catch(() => "");
    throw new Error(
      `BTWB ${toolName} create failed: HTTP ${createRes.status}. ${body.slice(0, 300)}`
    );
  }

  const location = createRes.headers.get("location") || "";
  const idMatch = location.match(/\/workouts\/(\d+)-([^/?]+)/);
  return {
    workoutId: idMatch ? Number(idMatch[1]) : null,
    workoutSlug: idMatch ? idMatch[2] : null,
    workoutName: name,
    existing: false,
    created: true,
    redirectedTo: location,
    definition,
  };
}

// Defines a single-movement "Sets" workout (e.g. "Bench Press : 3-3-3",
// "Ring Dips : 3x Max Rep", "Bench Press : 5-5-5 at 65/75/85% 1RM").
//
// BTWB's builder has two branches for this - #single/weight for loaded
// movements and #single/reps for bodyweight gymnastics - and they post
// different prescriptions. Pass bodyweight: true for a gymnastics movement
// (search_movement reports those with modality "gymnastics").
//
// All combinations below were captured from the real wizard; none is
// predictable from the others, so the table is written out rather than derived:
//
//   branch      reps   type                 scoring      movement carries
//   ---------------------------------------------------------------------------
//   weight      fixed  weightlifting/sets   totalWeight  reps, inputs[weight]
//   weight      max    weightlifting/sets   totalWeight  inputs[reps,weight]
//   weight      %1RM   weightlifting/sets   completed    reps, weight, inputs[weight]
//   gymnastics  fixed  gymnastics/sets      completed    reps
//   gymnastics  max    gymnastics/sets      totalReps    inputs[reps]
//
// Note scoring flips to "completed" once the load is prescribed as a
// percentage - there's nothing left to score when the weight is dictated.
//
// `contents` repeats once PER SET, so a varying wave (5/3/1, or 65/75/85%)
// needs no special support: pass `setScheme` as one entry per set and each
// carries its own reps and percentage.
export async function createSetsWorkout({
  movementName,
  movementId,
  sets,
  reps,
  maxReps = false,
  percent,
  setScheme,
  bodyweight = false,
  weightPerSet = "heaviest",
  name,
  description,
}) {
  // One entry per set: either the explicit scheme, or `sets` copies of a
  // uniform one.
  const scheme = setScheme
    ? setScheme
    : Array.from({ length: sets || 0 }, () => ({ reps, maxReps, percent }));

  if (!scheme.length) {
    throw new Error("create_sets_workout needs either sets (with reps or maxReps) or setScheme.");
  }
  for (const set of scheme) {
    if (!set.maxReps && set.reps == null) {
      throw new Error("Every set needs reps, or maxReps: true.");
    }
    if (set.percent != null && (set.percent <= 0 || set.percent > 200)) {
      throw new Error(`percent looks wrong: ${set.percent} (expected a %1RM like 75).`);
    }
  }

  const usesPercent = scheme.some((set) => set.percent != null);
  if (usesPercent && bodyweight) {
    throw new Error("percent applies to loaded movements; a bodyweight movement has no %1RM.");
  }

  const prescription = bodyweight
    ? {
        type: "gymnastics/sets",
        scoring: scheme.every((set) => set.maxReps) ? "totalReps" : "completed",
      }
    : {
        type: "weightlifting/sets",
        weightPerSet: usesPercent ? "onerepmax" : weightPerSet,
        scoring: usesPercent ? "completed" : "totalWeight",
      };

  const contents = scheme.map((set) => {
    // inputs are what the logger collects afterwards: reps only when they
    // aren't prescribed, weight only when the movement is loaded. A
    // prescribed-reps gymnastics set collects nothing, so the key is dropped.
    const inputs = [...(set.maxReps ? ["reps"] : []), ...(bodyweight ? [] : ["weight"])];
    return {
      type: "movement",
      movementName,
      movementId,
      ...(set.maxReps ? {} : { reps: { value: set.reps, unit: "reps" } }),
      ...(set.percent != null ? { weight: { value: set.percent, unit: "onerepmax" } } : {}),
      ...(inputs.length ? { inputs } : {}),
    };
  });

  return saveWorkoutDefinition({
    toolName: "create_sets_workout",
    prescription,
    contents,
    name,
    description,
  });
}

// Defines a monostructural "For Distance" workout - run/row/bike/ski for a
// fixed time, scored on the distance covered (e.g. "Run : 30 mins"). This is
// BTWB's third builder branch, #single/distance, alongside #single/weight and
// #single/reps.
//
//   prescription: { type: "monostructural/sets", scoring: "totalDistance",
//                   tempo?: { value, unit: "RPE" } }
//   movement:     { time: { value, unit: "seconds" }, inputs: ["distance"] }
//
// `rpe` is optional and uses the Borg scale BTWB exposes (6-20): 9 is "very
// light", 11 "fairly light", 13 "steady pace", 15 "hard", 17 "very hard". It's
// the only way this API expresses intended effort - there's no heart-rate
// target - so an easy aerobic run is best said as a low RPE rather than left
// blank, which would otherwise read as "run this as hard as you can".
export async function createForDistanceWorkout({
  movementName,
  movementId,
  sets = 1,
  durationSeconds,
  rpe,
  name,
  description,
}) {
  if (!durationSeconds) {
    throw new Error("create_for_distance_workout needs durationSeconds.");
  }
  if (rpe != null && (rpe < 6 || rpe > 20)) {
    throw new Error(`rpe must be on BTWB's Borg scale, 6-20 (got ${rpe}).`);
  }

  const movement = {
    type: "movement",
    movementName,
    movementId,
    time: { value: Math.round(durationSeconds), unit: "seconds" },
    inputs: ["distance"],
  };

  return saveWorkoutDefinition({
    toolName: "create_for_distance_workout",
    prescription: {
      type: "monostructural/sets",
      ...(rpe != null ? { tempo: { value: rpe, unit: "RPE" } } : {}),
      scoring: "totalDistance",
    },
    contents: Array.from({ length: sets }, () => movement),
    name,
    description,
  });
}

// Defines a monostructural "Intervals / Repeats" workout - repeated efforts
// over a fixed distance, each timed (e.g. "Run : 4x 800 m at 80%, rest 2
// mins"). Same #single/distance branch as createForDistanceWorkout; the two
// are mirror images and differ by which dimension is prescribed:
//
//   For Distance : fixed time,     collects distance, scoring totalDistance
//   Intervals    : fixed distance, collects time,     scoring totalTime
//
// `restSeconds` maps to BTWB's rest picker, which only offers 10/15/20/30/45/
// 60/90/120/150/180/240 - other values are rejected.
export async function createIntervalsWorkout({
  movementName,
  movementId,
  intervals,
  distance,
  distanceUnit = "m",
  restSeconds,
  rpe,
  name,
  description,
}) {
  if (!intervals || !distance) {
    throw new Error("create_intervals_workout needs intervals and distance.");
  }
  const UNITS = ["m", "km", "ft", "yd", "mi", "in"];
  if (!UNITS.includes(distanceUnit)) {
    throw new Error(`distanceUnit must be one of ${UNITS.join(", ")} (got "${distanceUnit}").`);
  }
  const RESTS = [10, 15, 20, 30, 45, 60, 90, 120, 150, 180, 240];
  if (restSeconds != null && !RESTS.includes(restSeconds)) {
    throw new Error(
      `restSeconds must be one of ${RESTS.join(", ")} - BTWB's picker offers no others ` +
        `(got ${restSeconds}).`
    );
  }
  if (rpe != null && (rpe < 6 || rpe > 20)) {
    throw new Error(`rpe must be on BTWB's Borg scale, 6-20 (got ${rpe}).`);
  }

  const movement = {
    type: "movement",
    movementName,
    movementId,
    distance: { value: distance, unit: distanceUnit },
    inputs: ["time"],
  };

  return saveWorkoutDefinition({
    toolName: "create_intervals_workout",
    prescription: {
      type: "monostructural/sets",
      ...(restSeconds != null ? { rest: { value: restSeconds, unit: "seconds" } } : {}),
      ...(rpe != null ? { tempo: { value: rpe, unit: "RPE" } } : {}),
      scoring: "totalTime",
    },
    contents: Array.from({ length: intervals }, () => movement),
    name,
    description,
  });
}

// Defines an AMRAP - as many rounds as possible of the given movements in a
// fixed time. Scored on total rounds, which is the scoring type none of the
// log_* tools handle yet. Movement `reps` are optional: BTWB omits the key
// entirely when a movement has no prescribed reps.
export async function createAmrapWorkout({ minutes, movements, name, description }) {
  const contents = movements.map(({ movementName, movementId, reps }) => ({
    type: "movement",
    movementName,
    movementId,
    ...(reps != null ? { reps: { value: reps, unit: "reps" } } : {}),
  }));

  return saveWorkoutDefinition({
    toolName: "create_amrap_workout",
    prescription: {
      type: "amrap",
      time: { value: Math.round(minutes * 60), unit: "seconds" },
      inputs: ["rounds"],
      scoring: "totalRounds",
    },
    contents,
    name,
    description,
  });
}

// Loads a workout's "Plan" form - the page behind the Plan button on any
// workout - and returns what's needed to post it back: the form's own CSRF
// token, the pre-generated group name, and the tracks the member can schedule
// onto.
async function loadPlanForm(workoutId) {
  const html = await fetchPageHtml(`/plan/track_events/workouts/${workoutId}/new`);

  // The form is server-rendered but its authenticity_token input is NOT -
  // Rails/Turbo injects that client-side from the csrf-token meta tag ON THIS
  // PAGE. Take it from here rather than from getCsrfToken(), which reads
  // /whiteboard: that's a second request which can rotate the session cookie
  // out from under the token it just minted. Same reasoning for
  // track_event[task_id] - it's the workout id from the URL, not the markup.
  const csrfToken = html.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1];
  if (!csrfToken) {
    throw new Error(
      `Could not read a CSRF token from the Plan form for workout ${workoutId}.`
    );
  }

  // BTWB pre-fills a random group name per form; workouts sharing one land in
  // the same session block on the calendar. Note value= precedes name= here.
  const groupName =
    html.match(/<input[^>]*value="([^"]+)"[^>]*name="track_event\[group_name\]"/)?.[1] || "";

  const selectHtml = html.match(
    /<select[^>]*name="track_event\[track_id\]"[\s\S]*?<\/select>/
  )?.[0];
  if (!selectHtml) {
    throw new Error(
      `Could not read the Plan form for workout ${workoutId} - check the id, ` +
        "or BTWB's planner may have changed."
    );
  }
  const tracks = [...selectHtml.matchAll(/<option value="(\d+)"[^>]*>\s*([^<]+?)\s*<\/option>/g)]
    .map(([, id, label]) => ({ trackId: Number(id), name: decodeHtmlEntities(label) }));

  return { csrfToken, groupName, tracks };
}

// The tracks this member can schedule onto, with their ids. Read from any
// workout's Plan form, since that's where BTWB exposes the picker.
export async function getTracks({ workoutId = 2 } = {}) {
  const { tracks } = await loadPlanForm(workoutId);
  return { tracks };
}

// Schedules an existing workout onto a track for a date - the same request
// BTWB's "Plan Workout" button sends. This is what puts a workout on the
// calendar; create_sets_workout and friends only define workouts, they don't
// schedule them.
//
// Pass the same groupName for several workouts on one date to group them into
// a single session block; omit it and each gets BTWB's own random group.
export async function scheduleWorkout({ workoutId, trackId, date, title = "", groupName }) {
  const form = await loadPlanForm(workoutId);

  if (!trackId) {
    const names = form.tracks.map((t) => `${t.trackId} (${t.name})`).join(", ");
    throw new Error(`schedule_workout needs a trackId. Available: ${names || "none"}`);
  }

  // BTWB validates group_name as alphanumeric - anything else (a hyphen is
  // enough) comes back as a 422 with the form re-rendered, which looks exactly
  // like a CSRF rejection and is easy to misdiagnose as one. Its own values are
  // 12-char alphanumeric tokens.
  if (groupName && !/^[A-Za-z0-9]+$/.test(groupName)) {
    throw new Error(
      `schedule_workout: groupName must be alphanumeric (got "${groupName}"). ` +
        "BTWB rejects anything else with a 422."
    );
  }

  const body = new URLSearchParams({
    authenticity_token: form.csrfToken,
    "track_event[translations][content_locale]": "en-US",
    "track_event[task_type]": "Workout",
    "track_event[task_id]": String(workoutId),
    "track_event[track_id]": String(trackId),
    "track_event[event_date]": date,
    "track_event[title]": title,
    "track_event[group_name]": groupName || form.groupName,
  });

  const res = await fetch(`${BASE_URL}/plan/track_events/workouts`, {
    method: "POST",
    headers: {
      Cookie: cachedCookie,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRF-Token": form.csrfToken,
    },
    body,
    redirect: "manual",
  });

  if (![302, 303].includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw new Error(`BTWB schedule_workout failed: HTTP ${res.status}. ${text.slice(0, 300)}`);
  }

  const location = res.headers.get("location") || "";
  const trackEventId = location.match(/\/track_events\/workouts\/(\d+)/)?.[1];
  return {
    success: true,
    trackEventId: trackEventId ? Number(trackEventId) : null,
    workoutId,
    trackId,
    date,
    groupName: groupName || form.groupName,
    redirectedTo: location,
  };
}

// Removes a scheduled workout from the calendar. Unlike workout definitions -
// which live in BTWB's shared library and can't be deleted - a track event
// belongs to the member, so this is the undo for schedule_workout.
export async function deleteTrackEvent(trackEventId) {
  const csrfToken = await getCsrfToken();
  const res = await fetch(`${BASE_URL}/plan/track_events/${trackEventId}`, {
    method: "DELETE",
    headers: { Cookie: cachedCookie, "X-CSRF-Token": csrfToken, Accept: "text/html" },
    redirect: "manual",
  });
  if (![200, 204, 302, 303].includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `BTWB delete_track_event failed: HTTP ${res.status}. ${text.slice(0, 300)}`
    );
  }
  return { success: true, trackEventId };
}

// Rails' standard destroy action - the same request its own UJS delete links
// (data-method="delete") trigger, just issued directly as a real HTTP DELETE
// instead of simulating the link click.
export async function deleteWorkoutSession(sessionId) {
  const csrfToken = await getCsrfToken();
  const cookie = await getCookie();

  const res = await fetch(`${BASE_URL}/workout_sessions/${sessionId}`, {
    method: "DELETE",
    headers: {
      Cookie: cookie,
      "X-CSRF-Token": csrfToken,
    },
    redirect: "manual",
  });

  if (![200, 204, 302, 303].includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `BTWB delete_workout_session failed: HTTP ${res.status}. ${text.slice(0, 300)}`
    );
  }

  return { success: true, sessionId };
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

// There's no JSON endpoint for a single workout_session (unlike search/log/
// history) - this scrapes the session's page HTML instead. Built against the
// "Lifting Complex" (CrossFit Total) page template; other workout types
// (single-movement, named/benchmark WODs) use the same "Sets" / "Result"
// section labels as of this writing, but haven't all been tested - if BTWB
// changes their markup, or a workout type renders differently, the relevant
// field will just come back null/empty rather than throwing.
export async function getWorkoutSession(sessionId) {
  const res = await fetch(`${BASE_URL}/workout_sessions/${sessionId}`, {
    headers: { Cookie: await getCookie() },
  });
  if (!res.ok) {
    throw new Error(`BTWB workout session fetch failed: HTTP ${res.status}`);
  }
  const html = await res.text();

  const nameMatch = html.match(
    /class="h4 fw-semibold text-dark text-uppercase text-decoration-none d-none d-lg-block"[^>]*>([^<]+)<\/a>/
  );
  const workoutName = nameMatch ? decodeHtmlEntities(nameMatch[1]) : null;

  const dateMatch = html.match(/mdi-calendar-blank"><\/span>\s*([\d-]+)/);
  const timeMatch = html.match(/mdi-clock-outline"><\/span>\s*([\d: ]+(?:AM|PM))/);
  const performedDate = dateMatch ? dateMatch[1].trim() : null;
  const performedTime = timeMatch ? timeMatch[1].trim() : null;

  const setsMatch = html.match(/<p>Sets\s*([\s\S]*?)<\/p>/);
  let sets = null;
  if (setsMatch) {
    sets = setsMatch[1]
      .split(/<br\s*\/?>/)
      .map((line) => decodeHtmlEntities(line.replace(/<[^>]+>/g, "")))
      .filter(Boolean);
  }

  const resultMatch = html.match(
    /Result<\/p>\s*<div class="row[^>]*>\s*<div class="d-inline[^>]*>\s*<span class="text-dark text-decoration-none"[^>]*>\s*([^<]+?)\s*<\/span>/
  );
  const result = resultMatch ? decodeHtmlEntities(resultMatch[1]) : null;

  const levelMatch = html.match(/Level (\d+)/);
  const wodRankMatch = html.match(/(\d+)(?:st|nd|rd|th) WOD/);

  return {
    sessionId,
    url: `${BASE_URL}/workout_sessions/${sessionId}`,
    workoutName,
    performedDate,
    performedTime,
    sets,
    result,
    level: levelMatch ? Number(levelMatch[1]) : null,
    wodRank: wodRankMatch ? Number(wodRankMatch[1]) : null,
  };
}

// Authenticated GET of any BTWB page, returning its HTML - with the same
// expired-session fallback as getCsrfToken(). Used by the scraping readers.
async function fetchPageHtml(path) {
  let res = await fetch(`${BASE_URL}${path}`, { headers: { Cookie: await getCookie() } });
  cachedCookie = mergeSetCookies(cachedCookie, res.headers);
  let html = await res.text();
  if (!/<meta name="csrf-token"/.test(html)) {
    await refreshSessionCookie();
    res = await fetch(`${BASE_URL}${path}`, { headers: { Cookie: await getCookie() } });
    cachedCookie = mergeSetCookies(cachedCookie, res.headers);
    html = await res.text();
  }
  if (!res.ok) throw new Error(`BTWB fetch of ${path} failed: HTTP ${res.status}`);
  return html;
}
