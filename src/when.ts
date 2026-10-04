// Parses the close times people actually type: "2h", "30m", "3d", "8pm",
// "tomorrow 9am", "fri 8:30pm", "sat". Local time. Returns null if unsure.

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const UNITS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, hr: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function parseWhen(input: string, now = new Date()): Date | null {
  const s = input.trim().toLowerCase().replace(/^(in|by|at|until)\s+/, "");

  const rel = s.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/);
  if (rel) {
    const unit = rel[2]!.replace(/s$/, "").replace(/^minute$/, "min").replace(/^hour$/, "h").replace(/^day$/, "d").replace(/^week$/, "w");
    const ms = UNITS[unit] ?? UNITS[unit[0]!]!;
    return new Date(now.getTime() + Number(rel[1]) * ms);
  }

  // [today|tomorrow|<weekday>] [time]
  const m = s.match(/^(today|tonight|tomorrow|tmrw|sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?(?:\s+(.+))?$|^(.+)$/);
  if (!m) return null;
  const dayWord = m[1];
  const timeText = m[1] ? m[2] : m[3];

  const d = new Date(now);
  let hour = dayWord === "tonight" ? 23 : 21; // a bare day means 9pm that day, "tonight" 11pm
  let minute = 0;
  if (timeText) {
    const t = timeText.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!t) return null;
    hour = Number(t[1]);
    minute = Number(t[2] ?? 0);
    if (t[3] === "pm" && hour < 12) hour += 12;
    if (t[3] === "am" && hour === 12) hour = 0;
    if (!t[3] && hour < 8) hour += 12; // "at 7" in a group chat means 7pm
    if (hour > 23 || minute > 59) return null;
  }
  d.setHours(hour, minute, 0, 0);

  if (dayWord === "tomorrow" || dayWord === "tmrw") d.setDate(d.getDate() + 1);
  else if (dayWord && DAYS.includes(dayWord.slice(0, 3))) {
    const ahead = (DAYS.indexOf(dayWord.slice(0, 3)) - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + ahead);
    if (d <= now) d.setDate(d.getDate() + 7);
  } else if (!dayWord && d <= now) {
    d.setDate(d.getDate() + 1); // "8pm" after 8pm means tomorrow
  }
  return d > now ? d : null;
}

/** "in 2h", "in 3 days", "Fri 8:30 PM" */
export function describeWhen(at: number, now = Date.now()): string {
  const ms = at - now;
  if (ms < 90 * 60_000) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 24 * 3_600_000) return `in ${Math.round(ms / 3_600_000)}h`;
  return new Date(at).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
}
