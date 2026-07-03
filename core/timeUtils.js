import fs from "fs";
import path from "path";

const DEFAULT_TIMEZONE = "America/New_York";
const WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const DEFAULT_YEARS_AHEAD = 2;

export function getMarketTimeZone() {
  const tz =
    (process.env.VS_MARKET_TIMEZONE || "").trim() ||
    (process.env.VS_EXECUTION_TIMEZONE || "").trim();
  return tz || DEFAULT_TIMEZONE;
}

export function parseMarketTime(value, defaultHour, defaultMinute) {
  if (!value || typeof value !== "string") {
    return { hour: defaultHour, minute: defaultMinute };
  }
  const parts = value.trim().split(":");
  if (parts.length !== 2) {
    return { hour: defaultHour, minute: defaultMinute };
  }
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return { hour: defaultHour, minute: defaultMinute };
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: defaultHour, minute: defaultMinute };
  }
  return { hour, minute };
}

function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = first.getUTCDay();
  const daysToWeekday = (weekday - firstWeekday + 7) % 7;
  const day = 1 + daysToWeekday + (n - 1) * 7;
  return new Date(Date.UTC(year, month - 1, day));
}

function lastWeekday(year, month, weekday) {
  const nextMonth =
    month === 12
      ? new Date(Date.UTC(year + 1, 0, 1))
      : new Date(Date.UTC(year, month, 1));
  const last = new Date(nextMonth.getTime() - 86400000);
  const lastWeekdayIndex = last.getUTCDay();
  const daysBack = (lastWeekdayIndex - weekday + 7) % 7;
  return new Date(last.getTime() - daysBack * 86400000);
}

function observedDate(actual) {
  const day = actual.getUTCDay();
  if (day === 6) {
    return new Date(actual.getTime() - 86400000);
  }
  if (day === 0) {
    return new Date(actual.getTime() + 86400000);
  }
  return actual;
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const ell = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * ell) / 451);
  const month = Math.floor((h + ell - 7 * m + 114) / 31);
  const day = ((h + ell - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function dateToString(date) {
  return date.toISOString().slice(0, 10);
}

function generateHolidayCalendar(yearsAhead = DEFAULT_YEARS_AHEAD) {
  const now = new Date();
  const startYear = now.getUTCFullYear();
  const endYear = startYear + yearsAhead - 1;
  const holidays = new Set();
  const earlyCloses = [];

  for (let year = startYear; year <= endYear; year += 1) {
    const fixed = [
      new Date(Date.UTC(year, 0, 1)),
      new Date(Date.UTC(year, 5, 19)),
      new Date(Date.UTC(year, 6, 4)),
      new Date(Date.UTC(year, 11, 25)),
    ];
    for (const actual of fixed) {
      holidays.add(dateToString(observedDate(actual)));
    }

    holidays.add(dateToString(nthWeekday(year, 1, 1, 3))); // MLK Day
    holidays.add(dateToString(nthWeekday(year, 2, 1, 3))); // Presidents Day
    holidays.add(dateToString(lastWeekday(year, 5, 1))); // Memorial Day
    holidays.add(dateToString(nthWeekday(year, 9, 1, 1))); // Labor Day
    holidays.add(dateToString(nthWeekday(year, 11, 4, 4))); // Thanksgiving

    const easter = easterSunday(year);
    const goodFriday = new Date(easter.getTime() - 2 * 86400000);
    holidays.add(dateToString(goodFriday));

    const thanksgiving = nthWeekday(year, 11, 4, 4);
    const dayAfter = new Date(thanksgiving.getTime() + 86400000);
    if (dayAfter.getUTCDay() >= 1 && dayAfter.getUTCDay() <= 5) {
      if (!holidays.has(dateToString(dayAfter))) {
        earlyCloses.push({
          date: dateToString(dayAfter),
          close_time: "13:00",
          label: "Day after Thanksgiving",
        });
      }
    }

    const christmasEve = new Date(Date.UTC(year, 11, 24));
    if (
      christmasEve.getUTCDay() >= 1 &&
      christmasEve.getUTCDay() <= 5 &&
      !holidays.has(dateToString(christmasEve))
    ) {
      earlyCloses.push({
        date: dateToString(christmasEve),
        close_time: "13:00",
        label: "Christmas Eve",
      });
    }

    const julyFourth = new Date(Date.UTC(year, 6, 4));
    const julyThird = new Date(Date.UTC(year, 6, 3));
    if (
      julyFourth.getUTCDay() >= 1 &&
      julyFourth.getUTCDay() <= 5 &&
      julyThird.getUTCDay() >= 1 &&
      julyThird.getUTCDay() <= 5 &&
      !holidays.has(dateToString(julyThird))
    ) {
      earlyCloses.push({
        date: dateToString(julyThird),
        close_time: "13:00",
        label: "Independence Day Eve",
      });
    }
  }

  return {
    holidays: Array.from(holidays),
    earlyCloses,
  };
}

export function getMarketOpenClose(date = new Date()) {
  const open = parseMarketTime(process.env.VS_MARKET_OPEN_TIME, 9, 30);
  let close = parseMarketTime(process.env.VS_MARKET_CLOSE_TIME, 16, 0);
  const earlyClose = getEarlyCloseTime(getExchangeDateString(date));
  if (earlyClose) {
    close = earlyClose;
  }
  return { open, close };
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function getPreviousTradingDate(date = new Date()) {
  let cursor = addDays(getExchangeDateString(date), -1);
  while (isWeekendDate(cursor) || isMarketHolidayDate(cursor)) {
    cursor = addDays(cursor, -1);
  }
  return cursor;
}

function isWeekendDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export function getExchangeParts(
  date = new Date(),
  timeZone = getMarketTimeZone(),
) {
  const d = date instanceof Date ? date : new Date(date);
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    });
    const parts = fmt.formatToParts(d);
    const map = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = part.value;
      }
    }
    const weekday = map.weekday ? WEEKDAY_INDEX[map.weekday] : null;
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
      weekday,
    };
  } catch {
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      weekday: d.getDay(),
    };
  }
}

export function getExchangeTimeParts(date = new Date()) {
  const parts = getExchangeParts(date);
  return {
    hour: Number.isFinite(parts.hour) ? parts.hour : 0,
    minute: Number.isFinite(parts.minute) ? parts.minute : 0,
  };
}

export function getExchangeDateString(date = new Date()) {
  const parts = getExchangeParts(date);
  if (
    Number.isFinite(parts.year) &&
    Number.isFinite(parts.month) &&
    Number.isFinite(parts.day)
  ) {
    const month = String(parts.month).padStart(2, "0");
    const day = String(parts.day).padStart(2, "0");
    return `${parts.year}-${month}-${day}`;
  }
  const fallback = date instanceof Date ? date : new Date(date);
  return fallback.toISOString().slice(0, 10);
}

function loadHolidayList() {
  const disabled = (process.env.VS_MARKET_HOLIDAYS_DISABLED || "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "y"].includes(disabled)) {
    return { holidays: [], earlyCloses: [] };
  }
  const holidayPath =
    process.env.VS_MARKET_HOLIDAYS_FILE ||
    path.join(process.cwd(), "data", "market-holidays.json");
  const generated = generateHolidayCalendar();
  if (!fs.existsSync(holidayPath)) {
    return generated;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(holidayPath, "utf8"));
    const holidays = Array.isArray(payload?.holidays)
      ? payload.holidays
      : generated.holidays;
    const earlyClosesRaw = Array.isArray(payload?.early_closes)
      ? payload.early_closes
      : [];
    const earlyCloses = [
      ...generated.earlyCloses,
      ...earlyClosesRaw
        .map((entry) => {
          if (typeof entry === "string")
            return { date: entry, close_time: "13:00" };
          if (entry && typeof entry === "object" && entry.date) {
            return {
              date: entry.date,
              close_time: entry.close_time || "13:00",
            };
          }
          return null;
        })
        .filter(Boolean),
    ]
      .reverse()
      .filter(
        (entry, index, all) =>
          all.findIndex((candidate) => candidate.date === entry.date) === index,
      )
      .reverse()
      .map((entry) => {
        return {
          date: entry.date,
          close_time: entry.close_time || "13:00",
        };
      });
    return {
      holidays: holidays.filter((item) => typeof item === "string"),
      earlyCloses,
    };
  } catch {
    return generateHolidayCalendar();
  }
}

export function isMarketHolidayDate(dateString) {
  const calendar = loadHolidayList();
  return calendar.holidays.includes(dateString);
}

export function isMarketHoliday(date = new Date()) {
  const today = getExchangeDateString(date);
  return isMarketHolidayDate(today);
}

export function isTradingDay(date = new Date()) {
  const today = getExchangeDateString(date);
  return !isWeekendDate(today) && !isMarketHolidayDate(today);
}

export function getEarlyCloseTime(dateString) {
  const calendar = loadHolidayList();
  for (const entry of calendar.earlyCloses) {
    if (entry?.date === dateString) {
      return parseMarketTime(entry.close_time, 13, 0);
    }
  }
  return null;
}

export function isMarketOpenNow(date = new Date()) {
  const parts = getExchangeParts(date);
  const weekday = parts.weekday;
  if (weekday === 0 || weekday === 6) return false;
  if (isMarketHolidayDate(getExchangeDateString(date))) return false;
  const { open, close } = getMarketOpenClose(date);
  const nowMinutes = (parts.hour || 0) * 60 + (parts.minute || 0);
  const openMinutes = open.hour * 60 + open.minute;
  const closeMinutes = close.hour * 60 + close.minute;
  return nowMinutes >= openMinutes && nowMinutes < closeMinutes;
}

export function minutesUntilClose(date = new Date()) {
  const parts = getExchangeParts(date);
  const { close } = getMarketOpenClose(date);
  const nowMinutes = (parts.hour || 0) * 60 + (parts.minute || 0);
  const closeMinutes = close.hour * 60 + close.minute;
  return closeMinutes - nowMinutes;
}

export function isWithinPreCloseWindow(windowMinutes, date = new Date()) {
  if (!isTradingDay(date)) return false;
  const minutes = minutesUntilClose(date);
  return minutes > 0 && minutes <= windowMinutes;
}

export function minutesSinceClose(date = new Date()) {
  if (!isTradingDay(date)) return null;
  const parts = getExchangeParts(date);
  const { close } = getMarketOpenClose(date);
  const nowMinutes = (parts.hour || 0) * 60 + (parts.minute || 0);
  const closeMinutes = close.hour * 60 + close.minute;
  return nowMinutes - closeMinutes;
}

export function isWithinPostCloseWindow(
  startMinutesAfterClose,
  endMinutesAfterClose,
  date = new Date(),
) {
  const minutes = minutesSinceClose(date);
  if (minutes === null) return false;
  return minutes >= startMinutesAfterClose && minutes <= endMinutesAfterClose;
}

export function minutesUntilOpen(date = new Date()) {
  const parts = getExchangeParts(date);
  const { open } = getMarketOpenClose(date);
  const nowMinutes = (parts.hour || 0) * 60 + (parts.minute || 0);
  const openMinutes = open.hour * 60 + open.minute;
  return openMinutes - nowMinutes;
}

export function isWithinPreOpenWindow(windowMinutes, date = new Date()) {
  if (!isTradingDay(date)) return false;
  const minutes = minutesUntilOpen(date);
  return minutes > 0 && minutes <= windowMinutes;
}

export function isWithinMinutesBeforeCloseSlots(
  slotMinutes,
  date = new Date(),
) {
  if (!isTradingDay(date)) return false;
  if (!Array.isArray(slotMinutes) || !slotMinutes.length) return false;
  const minutes = minutesUntilClose(date);
  return slotMinutes.includes(minutes);
}

export function getNextMarketOpen(date = new Date()) {
  const { open } = getMarketOpenClose(date);
  const openStr = `${String(open.hour).padStart(2, "0")}:${String(
    open.minute,
  ).padStart(2, "0")}`;
  const today = getExchangeDateString(date);
  const parts = getExchangeParts(date);
  const nowMinutes = (parts.hour || 0) * 60 + (parts.minute || 0);
  const openMinutes = open.hour * 60 + open.minute;
  const todayIsTradingDay =
    !isWeekendDate(today) && !isMarketHolidayDate(today);

  if (todayIsTradingDay && nowMinutes < openMinutes) {
    return { date: today, time: openStr };
  }

  let cursor = addDays(today, 1);
  while (isWeekendDate(cursor) || isMarketHolidayDate(cursor)) {
    cursor = addDays(cursor, 1);
  }
  return { date: cursor, time: openStr };
}
