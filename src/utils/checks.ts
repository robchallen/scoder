import http from "node:http";
import { createRequire } from "node:module";
import { error, info } from "./logger.ts";

const require = createRequire(import.meta.url);
const net = require("node:net");

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
		const proc = await Bun.spawn(["bwrap", "--bind", "/", "/", "/bin/true"], {
			stdout: "pipe",
			stderr: "pipe",
		});

		await proc.exited;

		if (proc.exitCode === 0) {
			return;
		}

		const stderrBytes = await new Response(proc.stderr).arrayBuffer();
		const stderr = new TextDecoder().decode(stderrBytes);

		if (stderr.includes("setting up uid map")) {
			const restrict = await readSysctl(
				"kernel.apparmor_restrict_unprivileged_userns",
			);

			if (restrict === "1") {
				const profileExists = await fileExists(APPARMOR_PROFILE_PATH);

				if (profileExists) {
					error("bwrap cannot create user namespaces");
					error(
						`An AppArmor profile exists at ${APPARMOR_PROFILE_PATH} but may not be loaded`,
					);
					error(`Try: sudo apparmor_parser -r ${APPARMOR_PROFILE_PATH}`);
				} else {
					error("bwrap cannot create user namespaces");
					error(
						"AppArmor is restricting unprivileged user namespaces on this system",
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

// EM: Ports probed in addition to the primary one, and only accepted when
// EM: they answer GET /v1/models like an OpenAI-compatible server: 11435 is
// EM: a common second local LLM server (a second Ollama, llama.cpp, LM Studio
// EM: moved off the default), and unlike 11434 it is not Ollama's own, so an
// EM: open port alone is too weak a sign to forward it into the sandbox.
const OPENAI_PROBE_PORTS = [11435];

// ### detectLocalLlmPorts
// Host loopback ports that look like a local LLM API: the primary port
// (SCODER_LLM_PORT, default 11434) when anything listens on it, as before,
// plus each of OPENAI_PROBE_PORTS that serves an OpenAI-style /v1/models.
export async function detectLocalLlmPorts(): Promise<number[]> {
	const primary = parseInt(process.env.SCODER_LLM_PORT || "", 10) || 11434;
	const found: number[] = [];

	if (await tcpPortOpen(primary)) {
		info(`Auto-detected local OpenAI-compatible API on 127.0.0.1:${primary}`);
		found.push(primary);
	}
	for (const port of OPENAI_PROBE_PORTS) {
		if (port !== primary && (await servesOpenAiModels(port))) {
			info(
				`Auto-detected local OpenAI-compatible API on 127.0.0.1:${port} (/v1/models)`,
			);
			found.push(port);
		}
	}
	return found;
}

async function tcpPortOpen(port: number): Promise<boolean> {
	try {
		const socket = new net.Socket();
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
			socket.connect(port, "127.0.0.1");
		});
		socket.destroy();
		return true;
	} catch {
		return false;
	}
}

// ### servesOpenAiModels
// True when 127.0.0.1:port answers GET /v1/models with 200 and an
// OpenAI-style model list (`{"data": [...]}`).
//
// EM: node:http, not fetch: Bun's fetch honours HTTP_PROXY, and a host
// EM: proxy setting must not reroute a loopback probe. One second, so a
// EM: listener that accepts and never answers cannot stall start-up.
export function servesOpenAiModels(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const req = http.get(
			{ host: "127.0.0.1", port, path: "/v1/models", timeout: 1000 },
			(res) => {
				if (res.statusCode !== 200) {
					res.resume();
					resolve(false);
					return;
				}
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => {
					try {
						resolve(Array.isArray(JSON.parse(body)?.data));
					} catch {
						resolve(false);
					}
				});
			},
		);
		// EM: destroy() without an error emits no "error" event, so the
		// EM: timeout resolves explicitly — caught by the test's hanging
		// EM: server, which otherwise stalled the probe (and so start-up)
		// EM: indefinitely. The timer is a backstop for a server that sends
		// EM: headers and then stalls the body, which "timeout" alone misses.
		const deadline = setTimeout(() => {
			req.destroy();
			resolve(false);
		}, 1500);
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
		req.on("error", () => resolve(false));
		req.on("close", () => clearTimeout(deadline));
	});
}
