import { error, info, warning } from "../utils/logger.ts";

const APPARMOR_PROFILE_PATH = "/etc/apparmor.d/bwrap";

// ### configureAppArmor
// [IMPLEMENTS](/design/features/apparmor-compatibility.md)
export async function configureAppArmor(): Promise<void> {
  if (process.getuid?.() !== 0) {
    error("--configure-apparmor must be run as root");
    error("Usage: sudo scoder --configure-apparmor");
    process.exit(1);
  }

  const apparmorDirExists = await fileExists("/etc/apparmor.d");
  if (!apparmorDirExists) {
    error(
      "AppArmor does not appear to be installed (/etc/apparmor.d not found)"
    );
    process.exit(1);
  }

  const bwrapPath = await which("bwrap");
  if (!bwrapPath) {
    error("bwrap not found in PATH");
    process.exit(1);
  }

  const realBwrapPath = await realpath(bwrapPath);

  const existingProfile = await fileExists(APPARMOR_PROFILE_PATH);
  if (existingProfile) {
    info(`Existing profile found at ${APPARMOR_PROFILE_PATH}:`);
    const content = await Bun.file(APPARMOR_PROFILE_PATH).text();
    console.log(content);
    console.log("");
  }

  const profile = `# AppArmor profile for bubblewrap (bwrap)
# Installed by scoder to allow unprivileged user namespace creation.
# This is required on Ubuntu 24.04+ where AppArmor restricts userns.
# Same approach used by Chrome, Firefox, Flatpak, etc.

abi <abi/4.0>,
include <tunables/global>

profile bwrap ${realBwrapPath} flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
`;

  await Bun.write(APPARMOR_PROFILE_PATH, profile);
  info(`Wrote AppArmor profile to ${APPARMOR_PROFILE_PATH}`);

  const localDir = "/etc/apparmor.d/local";
  const localDirExists = await fileExists(localDir);
  if (!localDirExists) {
    await Bun.spawn(["mkdir", "-p", localDir]);
  }

  const localProfile = `${localDir}/bwrap`;
  const localProfileExists = await fileExists(localProfile);
  if (!localProfileExists) {
    await Bun.write(localProfile, "# Site-specific overrides for bwrap\n");
  }

  const apparmorParser = await which("apparmor_parser");
  if (apparmorParser) {
    const loadProc = await Bun.spawn([
      "apparmor_parser",
      "-r",
      APPARMOR_PROFILE_PATH,
    ]);

    await loadProc.exited;

    if (loadProc.exitCode === 0) {
      info("AppArmor profile loaded successfully");
    } else {
      error("Failed to load AppArmor profile");
      error(`Try: sudo apparmor_parser -r ${APPARMOR_PROFILE_PATH}`);
      process.exit(1);
    }
  } else {
    warning("apparmor_parser not found — profile written but not loaded");
    warning("Reload manually or reboot to activate");
  }

  info("Verifying bwrap can create user namespaces...");
  const sudoUser = process.env.SUDO_USER || "nobody";

  try {
    const testProc = await Bun.spawn([
      "su",
      "-c",
      "bwrap --bind / / /bin/echo SUCCESS",
      sudoUser,
    ]);

    await testProc.exited;

    const stdoutBytes = await new Response(testProc.stdout).arrayBuffer();
    const stdout = new TextDecoder().decode(stdoutBytes).trim();

    if (testProc.exitCode === 0 && stdout === "SUCCESS") {
      info("Verification passed — bwrap works for unprivileged users");
    } else {
      warning(`Verification inconclusive: ${stdout}`);
      warning("Try running './tests/validate.sh' as your normal user");
    }
  } catch (err) {
    warning(`Verification failed: ${err}`);
    warning("Try running './tests/validate.sh' as your normal user");
  }

  console.log("");
  info("Done. You can now run scoder as a normal user.");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
  }
}

async function which(cmd: string): Promise<string | null> {
  try {
    const proc = await Bun.spawn(["which", cmd], {
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;

    if (proc.exitCode === 0) {
      const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
      return new TextDecoder().decode(stdoutBytes).trim();
    }

    return null;
  } catch {
    return null;
  }
}

async function realpath(path: string): Promise<string> {
  try {
    const proc = await Bun.spawn(["realpath", path], {
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;

    if (proc.exitCode === 0) {
      const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
      return new TextDecoder().decode(stdoutBytes).trim();
    }

    return path;
  } catch {
    return path;
  }
}
