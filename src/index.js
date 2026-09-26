#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  searchMovement,
  logWorkout,
  logRoundsWorkout,
  logWeighIn,
  getWeighIns,
  getTrackEvents,
  logSetsWorkout,
  logForTimeWorkout,
  getMovementHistory,
  getMemberId,
  getWorkoutSession,
  deleteWorkoutSession,
  deleteWeighIn,
  refreshSessionCookie,
} from "./btwb-client.js";

const server = new Server(
  { name: "btwb-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "search_movement",
    description:
      "Search BTWB's movement library by name (e.g. 'Deadlift', 'Squat Clean'). " +
      "Returns matching movements with their numeric IDs, which log_workout and " +
      "get_movement_history both require.",
    inputSchema: {
      type: "object",
      properties: {
        term: {
          type: "string",
          description: "Movement name or partial name to search for",
        },
      },
      required: ["term"],
    },
  },
  {
    name: "log_workout",
    description:
      "Log a single-movement result (e.g. a 1-rep max) to BTWB. Every entry logged " +
      "through this tool is always posted with Privacy: Only Me - this is hardcoded " +
      "and cannot be overridden.",
    inputSchema: {
      type: "object",
      properties: {
        movementId: {
          type: "number",
          description: "Movement ID from search_movement",
        },
        movementName: {
          type: "string",
          description: "Movement name, should match the search_movement result",
        },
        reps: { type: "number", description: "Number of reps performed" },
        weight: { type: "number", description: "Weight lifted" },
        weightUnit: {
          type: "string",
          enum: ["lbs", "kg"],
          default: "lbs",
        },
        performedDate: {
          type: "string",
          description: "Date performed, format YYYY-MM-DD",
        },
        notes: {
          type: "string",
          description: "Optional notes for the entry",
        },
      },
      required: ["movementId", "movementName", "reps", "weight", "performedDate"],
    },
  },
  {
    name: "log_rounds_workout",
    description:
      "Log a multi-movement 'rounds' result (e.g. a For Time WOD with several " +
      "movements per round) to BTWB - as opposed to log_workout, which only " +
      "handles a single movement. Only 'For Time' workouts scored by total time " +
      "are supported (other scoring types like AMRAP/total-reps are untested). " +
      "workoutId/workoutSlug come from the workout's URL " +
      "(beyondthewhiteboard.com/workouts/{workoutId}-{workoutSlug}/...). " +
      "Every entry logged through this tool is always posted with Privacy: Only Me - " +
      "this is hardcoded and cannot be overridden.",
    inputSchema: {
      type: "object",
      properties: {
        workoutId: {
          type: "number",
          description: "Numeric workout ID from the workout's URL",
        },
        workoutSlug: {
          type: "string",
          description: "URL slug from the workout's URL, e.g. 'ft-rows-9x-toes-to-bars-power-cleans-and-wall-balls'",
        },
        memberId: {
          type: "number",
          description: "BTWB member/profile ID the result is logged under",
        },
        sections: {
          type: "array",
          description:
            "Ordered list of round groups making up the workout, e.g. a single " +
            "buy-in round followed by N rounds of several movements.",
          items: {
            type: "object",
            properties: {
              rounds: { type: "number", description: "Number of rounds for this section" },
              movements: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    movementName: { type: "string" },
                    movementId: { type: "number", description: "Movement ID from search_movement" },
                    measures: {
                      type: "object",
                      description:
                        "Per-round measures for this movement, keyed by measure type. " +
                        "Each value is {value, unit}. Common keys: reps ({value, unit:'reps'}), " +
                        "weight ({value, unit:'lbs'|'kg'}), distance ({value, unit:'m'|'ft'|...}), " +
                        "height ({value, unit:'ft'|'in'}). Include only the measures that apply " +
                        "to this movement (e.g. a weighted movement gets both reps and weight).",
                    },
                  },
                  required: ["movementName", "movementId", "measures"],
                },
              },
            },
            required: ["rounds", "movements"],
          },
        },
        totalTimeSeconds: {
          type: "number",
          description: "Total elapsed time in seconds (e.g. hit a 36:00 time cap -> 2160)",
        },
        performedDate: {
          type: "string",
          description: "Date performed, format YYYY-MM-DD",
        },
        rxd: {
          type: "boolean",
          description: "true = As Prescribed (Rx'd), false = Modified/scaled",
        },
        notes: {
          type: "string",
          description: "Optional notes for the entry",
        },
        trackEventId: {
          type: "number",
          description:
            "Optional track_event ID to link this result to a scheduled/prescribed " +
            "WOD (from get_workout_session or the workout's tracks page URL).",
        },
      },
      required: ["workoutId", "workoutSlug", "memberId", "sections", "totalTimeSeconds", "performedDate", "rxd"],
    },
  },
  {
    name: "log_weigh_in",
    description:
      "Log a body-weight entry to BTWB's Weigh-Ins tracker (beyondthewhiteboard.com/" +
      "members/{id}/weigh_ins) - the dedicated weigh-in feature, not the 'Weigh In' " +
      "movement. Weight is in the member's BTWB measure system (pounds for Imperial). " +
      "Note: BTWB's weigh-in form has no per-entry privacy setting, so visibility " +
      "follows the member's BTWB account settings, same as a weigh-in entered by hand.",
    inputSchema: {
      type: "object",
      properties: {
        weight: { type: "number", description: "Body weight, e.g. 238.9" },
        weighedInDate: {
          type: "string",
          description: "Date weighed, format YYYY-MM-DD",
        },
        hour: {
          type: "number",
          description: "Hour weighed, 0-23 (default 7)",
        },
        minute: {
          type: "number",
          description: "Minute weighed; BTWB only stores :00/:15/:30/:45, so it's rounded down (default 0)",
        },
        percentBodyFat: {
          type: "number",
          description: "Optional body fat percentage",
        },
        notes: {
          type: "string",
          description: "Optional notes for the entry",
        },
      },
      required: ["weight", "weighedInDate"],
    },
  },
  {
    name: "get_weigh_ins",
    description:
      "Read the signed-in member's BTWB Weigh-Ins tracker (beyondthewhiteboard.com/" +
      "members/{id}/weigh_ins): each entry's weight, BTWB's change vs. the previous " +
      "entry, and the weighed-in timestamp, newest first. Use it to confirm a " +
      "log_weigh_in landed or to pull recent weights for averages.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Only return entries from the last N days (omit for every entry on the page)",
        },
      },
    },
  },
  {
    name: "get_track_events",
    description:
      "List the scheduled track events (class programming, personal tracks, etc.) on " +
      "one day of the member's BTWB whiteboard calendar. Workout events include the " +
      "trackEventId plus the underlying workoutId/workoutSlug that log_sets_workout " +
      "and log_rounds_workout need to log a result against that track. Events that " +
      "already have a logged result come back as kind 'logged' with their sessionId.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Calendar day, format YYYY-MM-DD" },
        track: {
          type: "string",
          description: "Optional case-insensitive filter on the track name, e.g. 'class'",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "log_sets_workout",
    description:
      "Log a set-by-set lifting result (a weightlifting/sets workout such as a class " +
      "track's 'Bench Press : 3 @ 80%, ... 2 @ 85%') against that specific prescribed " +
      "workout - one actual weight per prescribed set, in order - optionally linked " +
      "to a track event. The performed date can differ from the track event's date " +
      "(e.g. a Friday class piece done Thursday). Use get_track_events to find the " +
      "workoutId/workoutSlug/trackEventId. Every entry logged through this tool is " +
      "always posted with Privacy: Only Me - this is hardcoded and cannot be overridden.",
    inputSchema: {
      type: "object",
      properties: {
        workoutId: { type: "number", description: "Numeric workout ID (from get_track_events or the workout URL)" },
        workoutSlug: { type: "string", description: "Workout URL slug (from get_track_events or the workout URL)" },
        sets: {
          type: "array",
          description: "One entry per prescribed set, in order",
          items: {
            type: "object",
            properties: {
              weight: { type: "number", description: "Actual weight lifted" },
              weightUnit: { type: "string", enum: ["lbs", "kg"], default: "lbs" },
              reps: { type: "number", description: "Actual reps, only if different from the prescription" },
            },
            required: ["weight"],
          },
        },
        performedDate: { type: "string", description: "Date performed, format YYYY-MM-DD" },
        rxd: { type: "boolean", default: true, description: "true = As Prescribed (Rx'd), false = Modified/scaled" },
        notes: { type: "string", description: "Optional notes for the entry" },
        trackEventId: { type: "number", description: "Optional track_event ID to link the result to (from get_track_events)" },
      },
      required: ["workoutId", "workoutSlug", "sets", "performedDate"],
    },
  },
  {
    name: "log_for_time_workout",
    description:
      "Log a finished For Time result (with or without a time cap) against that " +
      "specific prescribed workout - e.g. a class track's chipper - optionally linked " +
      "to a track event. Movements, reps and distances come from the workout's own " +
      "prescription; `loads` overrides a movement's load by position for a scaled " +
      "result (null keeps the prescribed load). Only results finished under the cap " +
      "are supported. Use get_track_events to find workoutId/workoutSlug/trackEventId. " +
      "Every entry logged through this tool is always posted with Privacy: Only Me - " +
      "this is hardcoded and cannot be overridden.",
    inputSchema: {
      type: "object",
      properties: {
        workoutId: { type: "number", description: "Numeric workout ID (from get_track_events or the workout URL)" },
        workoutSlug: { type: "string", description: "Workout URL slug (from get_track_events or the workout URL)" },
        totalTimeSeconds: { type: "number", description: "Finish time in seconds (e.g. 13:43 -> 823)" },
        performedDate: { type: "string", description: "Date performed, format YYYY-MM-DD" },
        rxd: { type: "boolean", default: true, description: "true = As Prescribed (Rx'd), false = Modified/scaled" },
        loads: {
          type: "array",
          description:
            "Optional per-item load overrides, aligned with the workout's prescribed " +
            "items in order; null (or omitted) keeps the prescribed load",
          items: {
            type: ["object", "null"],
            properties: {
              weight: { type: "number" },
              weightUnit: { type: "string", enum: ["lbs", "kg"], default: "lbs" },
            },
          },
        },
        notes: { type: "string", description: "Optional notes for the entry" },
        trackEventId: { type: "number", description: "Optional track_event ID to link the result to (from get_track_events)" },
      },
      required: ["workoutId", "workoutSlug", "totalTimeSeconds", "performedDate"],
    },
  },
  {
    name: "get_movement_history",
    description:
      "Get the full logged history for a movement over a date range - every " +
      "individual set (date, reps, weight), not just PRs - plus a computed " +
      "'Potential Max' trend line. Requires the movement's numeric ID plus its URL " +
      "slug (e.g. movementId 35, movementSlug 'deadlift' for " +
      "beyondthewhiteboard.com/.../35-deadlift). memberId defaults to the signed-in " +
      "member (see get_member_id).",
    inputSchema: {
      type: "object",
      properties: {
        memberId: {
          type: "number",
          description: "BTWB member/profile ID - omit to use the signed-in member",
        },
        movementId: { type: "number", description: "Movement ID" },
        movementSlug: {
          type: "string",
          description: "URL slug for the movement, e.g. 'deadlift'",
        },
        days: {
          type: "number",
          default: 365,
          description: "How many days of history to look back",
        },
      },
      required: ["movementId", "movementSlug"],
    },
  },
  {
    name: "get_member_id",
    description:
      "Get the signed-in BTWB member's own numeric member ID (the number in a " +
      "beyondthewhiteboard.com/members/{id} URL), which log_rounds_workout needs " +
      "and get_movement_history accepts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_workout_session",
    description:
      "Get the full details of one already-logged BTWB result by its session ID " +
      "(the number in a beyondthewhiteboard.com/workout_sessions/{id} URL): " +
      "workout name, performed date/time, the movements/sets, the result/score, " +
      "and level/WOD-rank stats. There's no search-by-date endpoint yet - you " +
      "need the session ID already (e.g. from a URL, or from log_workout's " +
      "redirectedTo field).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "number",
          description: "The workout_sessions ID",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "delete_workout_session",
    description:
      "Permanently delete an already-logged BTWB result by its session ID. " +
      "This cannot be undone - BTWB has no trash/undo for deleted sessions.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "number",
          description: "The workout_sessions ID to delete",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "delete_weigh_in",
    description:
      "Permanently delete an already-logged entry from BTWB's Weigh-Ins tracker " +
      "(beyondthewhiteboard.com/weigh_ins/{id}) by its numeric id - the id " +
      "get_weigh_ins returns for each entry. This cannot be undone - BTWB has no " +
      "trash/undo for deleted weigh-ins. Use this to remove a mis-dated or " +
      "duplicate entry (e.g. one logged with the wrong date/time by mistake).",
    inputSchema: {
      type: "object",
      properties: {
        weighInId: {
          type: "number",
          description: "The weigh_ins ID to delete (from get_weigh_ins' entries[].id)",
        },
      },
      required: ["weighInId"],
    },
  },
  {
    name: "refresh_session_cookie",
    description:
      "Manually re-authenticate to BTWB and replace the stored session cookie with a " +
      "fresh one. Every other tool already does this automatically when it detects an " +
      "expired session, so you normally don't need to call this directly - it's mainly " +
      "useful to proactively refresh, or to test that BTWB_EMAIL and the password are " +
      "set up correctly. Requires BTWB_EMAIL and a password - stored in Keychain " +
      "(service: btwb-password) on macOS, or the BTWB_PASSWORD env var on hosts without " +
      "Keychain - see README \"Automatic cookie refresh\".",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    switch (name) {
      case "search_movement":
        result = await searchMovement(args.term);
        break;
      case "log_workout":
        result = await logWorkout(args);
        break;
      case "log_rounds_workout":
        result = await logRoundsWorkout(args);
        break;
      case "log_weigh_in":
        result = await logWeighIn(args);
        break;
      case "get_weigh_ins":
        result = await getWeighIns(args);
        break;
      case "get_track_events":
        result = await getTrackEvents(args);
        break;
      case "log_sets_workout":
        result = await logSetsWorkout(args);
        break;
      case "log_for_time_workout":
        result = await logForTimeWorkout(args);
        break;
      case "get_movement_history":
        result = await getMovementHistory(args);
        break;
      case "get_member_id":
        result = { memberId: await getMemberId() };
        break;
      case "get_workout_session":
        result = await getWorkoutSession(args.sessionId);
        break;
      case "delete_workout_session":
        result = await deleteWorkoutSession(args.sessionId);
        break;
      case "delete_weigh_in":
        result = await deleteWeighIn(args.weighInId);
        break;
      case "refresh_session_cookie":
        result = await refreshSessionCookie();
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
