import {
  getMarketTimeZone,
  getMarketOpenClose,
  getExchangeDateString,
  getExchangeTimeParts,
  getNextMarketOpen,
  getEarlyCloseTime,
  isMarketHolidayDate,
  isMarketOpenNow,
  minutesUntilClose,
  isWithinPreCloseWindow,
} from "../core/timeUtils.js";

function fmtClock(parts) {
  const hour = String(parts.hour).padStart(2, "0");
  const minute = String(parts.minute).padStart(2, "0");
  return `${hour}:${minute}`;
}

const tz = getMarketTimeZone();
const nowParts = getExchangeTimeParts();
const nowDate = getExchangeDateString();
const isHoliday = isMarketHolidayDate(nowDate);
const { open, close } = getMarketOpenClose();
const earlyClose = getEarlyCloseTime(nowDate);
const openStr = `${String(open.hour).padStart(2, "0")}:${String(open.minute).padStart(2, "0")}`;
const closeStr = `${String(close.hour).padStart(2, "0")}:${String(close.minute).padStart(2, "0")}`;
const openNow = isMarketOpenNow();
const minutesToClose = minutesUntilClose();
const eodWindow = Number(process.env.VS_EOD_WINDOW_MINUTES_BEFORE_CLOSE ?? 10);
const inEodWindow = isWithinPreCloseWindow(eodWindow);
const nextOpen = getNextMarketOpen();

console.log("[time] Market timing");
console.log(`- timezone=${tz}`);
console.log(`- exchange_date=${nowDate}`);
console.log(`- exchange_time=${fmtClock(nowParts)}`);
console.log(`- market_hours=${openStr}-${closeStr}`);
console.log(`- market_open_now=${openNow}`);
console.log(`- is_holiday=${isHoliday}`);
console.log(`- early_close_time=${earlyClose ? fmtClock(earlyClose) : "none"}`);
console.log(`- minutes_until_close=${minutesToClose}`);
console.log(`- eod_window_minutes=${eodWindow}`);
console.log(`- in_eod_window=${inEodWindow}`);
console.log(`- next_open=${nextOpen.date} ${nextOpen.time} ${tz}`);
