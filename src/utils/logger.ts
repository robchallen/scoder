// EM: Colored output functions for scoder CLI
// EM: Provides error, warning, info, and infoBlue with quiet mode support

const RED = "\x1b[0;31m";
const YELLOW = "\x1b[1;33m";
const GREEN = "\x1b[0;32m";
const BLUE = "\x1b[0;34m";
const NC = "\x1b[0m";

let quiet = false;

export function setQuiet(value: boolean): void {
  quiet = value;
}

export function error(...args: unknown[]): void {
  console.error(`${RED}scoder: ${args.join(" ")}${NC}`);
}

export function warning(...args: unknown[]): void {
  console.error(`${YELLOW}scoder: ${args.join(" ")}${NC}`);
}

export function info(...args: unknown[]): void {
  if (!quiet) {
    console.error(`${GREEN}scoder: ${args.join(" ")}${NC}`);
  }
}

export function infoBlue(...args: unknown[]): void {
  if (!quiet) {
    console.error(`${BLUE}scoder: ${args.join(" ")}${NC}`);
  }
}
