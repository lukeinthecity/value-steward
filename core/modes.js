export const MODES = {
  INACTIVE: "INACTIVE",
  RECOVERY: "RECOVERY",
  LIVE: "LIVE",
  ERROR: "ERROR",
};

export function isValidMode(mode) {
  return Object.values(MODES).includes(mode);
}
