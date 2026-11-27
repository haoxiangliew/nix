// pi sets PI_OFFLINE for --offline too.
export function offline(): boolean {
  const flag = process.env.PI_OFFLINE?.toLowerCase();

  return flag === "1" || flag === "true" || flag === "yes";
}
