import { parseServerTime } from "../../lib/format.js";

// When a scheduled mail really goes. A rule — and the reminder check — runs
// once a day, at or after its time: the server catches up within the same day.
// So one that is switched on, or moved, past today's time does not wait for
// tomorrow — the engine runs it at its next check and real mail leaves.
// Workflow Center, Notification Rules and Reminder & Escalation ask before a
// click does that, and none of them shows a time already behind us as "next".

/** A server time (a rule's next run) that has already passed: it is due, not "next". */
export const isDue = (iso, now = new Date()) => {
  const at = parseServerTime(iso);
  return Boolean(at) && at <= now;
};

/**
 * Where a daily schedule stands right now: { dueNow, at }.
 *   schedule — { hour, minute, days }; days are the API's numbers (0 = Monday),
 *              left out for "every day" (the reminder check).
 *   dueNow   — today is one of its days and its time has passed.
 *   at       — that time today, or the first time it comes up; null when no day is chosen.
 * Read off this browser's clock. The server decides by the plant clock — the
 * same one on the plant's network.
 */
export function scheduleStart({ hour, minute, days }, now = new Date()) {
  for (let ahead = 0; ahead < 7; ahead += 1) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead, hour, minute);
    // getDay() counts from Sunday, the API from Monday.
    if (!days || days.includes((at.getDay() + 6) % 7)) return { dueNow: at <= now, at };
  }
  return { dueNow: false, at: null };
}

/**
 * Would saving `after` in place of `before` make the schedule due right now?
 * Both are { enabled, hour, minute, days }. Not when it was due already: its
 * run for today has then happened or is about to, whatever is saved.
 */
export const startsNow = (before, after, now = new Date()) =>
  Boolean(after.enabled) && scheduleStart(after, now).dueNow
  && !(before.enabled && scheduleStart(before, now).dueNow);

/**
 * When something that is due runs, as part of a sentence: "at the next check,
 * within a minute". `engine` is the engine block of the status reading; while
 * that has not loaded, the usual one-minute check is assumed.
 */
export function nextCheckWords(engine) {
  if (engine?.enabled === false) return "as soon as the mail engine is switched back on (it is off now)";
  const seconds = engine?.poll_seconds || 60;
  return `at the next check, within ${seconds <= 60 ? "a minute" : `${Math.ceil(seconds / 60)} minutes`}`;
}

/**
 * What an admin reads before a rule goes on, or is moved, past today's time.
 * `time` is its "HH:MM", `who` the audience in words ("5 addresses"). A run
 * already on record today may have been the day's scheduled one — only the
 * server knows — so the sentence then says "unless".
 */
export function runsTodayWords(rule, time, who, engine, now = new Date()) {
  const last = parseServerTime(rule.last_run?.at);
  const ran = last && last.toDateString() === now.toDateString()
    ? ", unless today's scheduled run has already happened" : "";
  return `Its time today (${time}) has already passed, so it runs ${nextCheckWords(engine)}, and mails ${who}${ran}.`;
}
