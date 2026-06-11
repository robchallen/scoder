import { error, info, warning } from "./logger.ts";

// EM: System checks for bwrap, pasta, AppArmor compatibility, and port detection
// EM: Implements apparmor-compatibility feature for Ubuntu 24.04+ systems

const APPARMOR_PROFILE_PATH = "/etc/apparmor.d/bwrap";

export async function commandExists(cmd: string): Promise<boolean> {
  // EM: Check if a command exists in PATH
  try {
    const proc = await Bun.spawn(["which", cmd], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export async function checkBwrapUserns(): Promise<void> {
  // EM: Verify bwrap can create user namespaces (AppArmor compatibility check)
  // EM: Implements apparmor-compatibility feature for Ubuntu 24.04+
  try {
    const proc = await Bun.spawn(
      ["bwrap", "--bind", "/", "/", "/bin/true"],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    await proc.exited;

    if (proc.exitCode === 0) {
      return;
    }

    const stderrBytes = await new Response(proc.stderr).arrayBuffer();
    const stderr = new TextDecoder().decode(stderrBytes);

    if (stderr.includes("setting up uid map")) {
      const restrict = await readSysctl(
        "kernel.apparmor_restrict_unprivileged_userns"
      );

      if (restrict === "1") {
        const profileExists = await fileExists(APPARMOR_PROFILE_PATH);

        if (profileExists) {
          error("bwrap cannot create user namespaces");
          error(
            `An AppArmor profile exists at ${APPARMOR_PROFILE_PATH} but may not be loaded`
          );
          error(`Try: sudo apparmor_parser -r ${APPARMOR_PROFILE_PATH}`);
        } else {
          error("bwrap cannot create user namespaces");
          error(
            "AppArmor is restricting unprivileged user namespaces on this system"
          );
          error("Fix: sudo scoder --configure-apparmor");
        }

        process.exit(1);
      }
    }

    error(`bwrap self-test failed: ${stderr}`);
    process.exit(1);
  } catch (err) {
    error(`bwrap self-test failed: ${err}`);
    process.exit(1);
  }
}

async function readSysctl(key: string): Promise<string> {
  try {
    const proc = await Bun.spawn(["sysctl", "-n", key], {
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;

    if (proc.exitCode === 0) {
      const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
      return new TextDecoder().decode(stdoutBytes).trim();
    }

    return "0";
  } catch {
    return "0";
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
  }
}

export async function detectDefaultLlmPort(): Promise<number | null> {
  try {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: 11434,
    } as any);

    socket.end();

    info("Auto-detected local OpenAI-compatible API on 127.0.0.1:11434");
    return 11434;
  } catch {
    return null;
  }
}
