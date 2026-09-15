// Working hours schedule helper for Astana timezone (UTC+05:00).
//
// The monitor runs every day between 06:00 and 20:00 Astana time.
// Scheduled workflow runs fire at :17 and :47, so the first daily run is at 06:17
// and the last daily run is at 19:47.

export const ASTANA_OFFSET_HOURS = 5;
export const WORKING_HOURS_START = 6; // 06:00
export const WORKING_HOURS_END = 20; // 20:00

/**
 * Returns the time components in the Astana timezone (UTC+05:00).
 */
export function getAstanaTime(date = new Date()) {
  const utcMs = date.getTime();
  const astanaMs = utcMs + ASTANA_OFFSET_HOURS * 60 * 60 * 1000;
  const astanaDate = new Date(astanaMs);
  const hours = astanaDate.getUTCHours();
  const minutes = astanaDate.getUTCMinutes();
  const seconds = astanaDate.getUTCSeconds();

  const pad = (n) => String(n).padStart(2, "0");
  const timeString = `${pad(hours)}:${pad(minutes)}`;

  return {
    hours,
    minutes,
    seconds,
    timeString,
    date: astanaDate,
  };
}

/**
 * Evaluates whether the given date falls within the working hours window in Astana.
 * By default: [06:00, 20:00).
 */
export function isWithinWorkingHours(
  date = new Date(),
  startHour = WORKING_HOURS_START,
  endHour = WORKING_HOURS_END,
) {
  const { hours, minutes } = getAstanaTime(date);
  const totalMinutes = hours * 60 + minutes;
  return totalMinutes >= startHour * 60 && totalMinutes < endHour * 60;
}

/**
 * Checks if the run is explicitly forced via command-line arguments or environment variables.
 */
export function isRunForced(env = process.env, argv = process.argv) {
  return (
    env.FORCE_RUN === "1" ||
    env.FORCE_RUN === "true" ||
    argv.includes("--force")
  );
}
