export const MODES = {
  INACTIVE: "INACTIVE",
  CATCHUP: "CATCHUP",
  RECOVERY: "RECOVERY",
  LIVE: "LIVE",
  ERROR: "ERROR",
};

export function isValidMode(mode) {
  return Object.values(MODES).includes(mode);
}
