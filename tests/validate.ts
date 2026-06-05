#!/usr/bin/env bun

import { $ } from "bun";

const SCODER_HOME = "/home/scoder";
const TEST_BASE = await mktemp("/tmp/scoder-test.XXXXXX");
let passed = 0;
let failed = 0;

interface TestCase {
  name: string;
  fn: () => Promise<boolean>;
}

const tests: TestCase[] = [
  { name: "home-isolation", fn: testHomeIsolation },
  { name: "system-read-only", fn: testSystemReadOnly },
  { name: "worktree-writable", fn: testWorktreeWritable },
  { name: "github-protected", fn: testGithubProtected },
  { name: "gitignore-protected", fn: testGitignoreProtected },
  { name: "agentreadonly-protected", fn: testAgentreadonlyProtected },
  { name: "worktree-branch-created", fn: testWorktreeBranchCreated },
  { name: "host-loopback-blocked", fn: testHostLoopbackBlocked },
  { name: "outbound-dns-works", fn: testOutboundDnsWorks },
  { name: "dry-run-uses-pasta", fn: testDryRunUsesPasta },
  { name: "no-worktree-mode", fn: testNoWorktreeMode },
];

async function main(): Promise<void> {
  console.log("====== scoder validation tests ======\n");

  for (const test of tests) {
    try {
      console.log(`Test: ${test.name}`);
      const result = await test.fn();

      if (result) {
        console.log("  PASS\n");
        passed++;
      } else {
        console.log("  FAIL\n");
        failed++;
      }
    } catch (err) {
      console.error(`  FAIL: ${err}\n`);
      failed++;
    }
  }

  if (failed === 0) {
    console.log(`All ${passed} tests passed`);
    await cleanup();
    process.exit(0);
  } else {
    console.error(`${failed} test(s) failed, ${passed} passed`);
    await cleanup();
    process.exit(1);
  }
}

async function testHomeIsolation(): Promise<boolean> {
  const repoDir = await createTestRepo("home-isolation");
  const output = await runScoder(repoDir, ["-q", "/bin/bash", "-c", "printf '%s\n' $HOME"]);
  return output.includes(SCODER_HOME);
}

async function testSystemReadOnly(): Promise<boolean> {
  const repoDir = await createTestRepo("system-readonly");
  const output = await runScoder(repoDir, ["-q", "/bin/bash", "-c", "touch /usr/bin/scoder-test 2>&1 || true"]);
  return (
    output.includes("Read-only") ||
    output.includes("Permission denied") ||
    output.includes("cannot touch")
  );
}

async function testWorktreeWritable(): Promise<boolean> {
  const repoDir = await createTestRepo("worktree-writable");
  const output = await runScoder(repoDir, ["-q", "/bin/bash", "-c", "touch newfile.txt && echo SUCCESS"]);
  return output.includes("SUCCESS");
}

async function testGithubProtected(): Promise<boolean> {
  const repoDir = await createTestRepo("github-protected");
  const output = await runScoder(repoDir, ["-q", "/bin/bash", "-c", "touch .github/test 2>&1 || true"]);
  return (
    output.includes("Read-only") ||
    output.includes("Permission denied") ||
    output.includes("cannot")
  );
}

async function testGitignoreProtected(): Promise<boolean> {
  const repoDir = await createTestRepo("gitignore-protected");
  const output = await runScoder(repoDir, ["-q", "/bin/bash", "-c", "echo 'test' >> .gitignore 2>&1 || true"]);
  return (
    output.includes("Read-only") ||
    output.includes("Permission denied") ||
    output.includes("cannot")
  );
}

async function testAgentreadonlyProtected(): Promise<boolean> {
  const repoDir = await createTestRepo("agentreadonly-protected");
  await $`touch ${repoDir}/.agentreadonly`;
  await $`git -C ${repoDir} add -A`.quiet();
  await $`git -C ${repoDir} commit -m "add agentreadonly"`.quiet();

  const output = await runScoder(repoDir, ["-q", "/bin/bash", "-c", "echo 'test' >> .agentreadonly 2>&1 || true"]);
  return (
    output.includes("Read-only") ||
    output.includes("Permission denied") ||
    output.includes("cannot")
  );
}

async function testWorktreeBranchCreated(): Promise<boolean> {
  const repoDir = await createTestRepo("worktree-branch");
  await runScoder(repoDir, ["-q", "/bin/bash", "-c", "echo READY"]);

  const branches = await $`git -C ${repoDir} branch --list 'scoder/*'`.text();
  return branches.trim().length > 0;
}

async function testHostLoopbackBlocked(): Promise<boolean> {
  const repoDir = await createTestRepo("loopback-blocked");

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Response("SUCCESS");
    },
  });

  try {
    const port = server.port;
    const output = await runScoder(repoDir, [
      "-q",
      "/bin/bash",
      "-c",
      `curl -fsS --max-time 2 http://127.0.0.1:${port}/ 2>&1 || echo BLOCKED`,
    ]);

    return output.includes("BLOCKED");
  } finally {
    server.stop();
  }
}

async function testOutboundDnsWorks(): Promise<boolean> {
  const repoDir = await createTestRepo("outbound-dns");
  const output = await runScoder(repoDir, [
    "-q",
    "/bin/bash",
    "-c",
    "python3 -c 'import socket; socket.getaddrinfo(\"example.com\", 443)' && echo SUCCESS",
  ]);
  return output.includes("SUCCESS");
}

async function testDryRunUsesPasta(): Promise<boolean> {
  const repoDir = await createTestRepo("dry-run");
  const output = await runScoder(repoDir, ["--dry-run", "/bin/true"]);
  return output.includes("pasta");
}

async function testNoWorktreeMode(): Promise<boolean> {
  const repoDir = await createTestRepo("no-worktree");

  const output = await runScoder(repoDir, ["--no-worktree", "--dry-run", "/bin/true"]);

  const branches = await $`git -C ${repoDir} branch --list 'scoder/*'`.text();

  return output.includes("direct mode") && branches.trim().length === 0;
}

async function createTestRepo(name: string): Promise<string> {
  const caseDir = `${TEST_BASE}/${name}`;
  const repoDir = `${caseDir}/repo`;

  await $`mkdir -p ${repoDir}`;
  await $`git -C ${repoDir} init -q`;
  await $`git -C ${repoDir} config user.email "test@scoder"`;
  await $`git -C ${repoDir} config user.name "scoder-test"`;
  await $`echo "test" > ${repoDir}/file.txt`;
  await $`mkdir -p ${repoDir}/.github`;
  await $`echo "workflow" > ${repoDir}/.github/ci.yml`;
  await $`echo "*.pyc" > ${repoDir}/.gitignore`;
  await $`echo "{}" > ${repoDir}/package-lock.json`;
  await $`git -C ${repoDir} add -A`.quiet();
  await $`git -C ${repoDir} commit -q -m "initial"`.quiet();

  return repoDir;
}

async function runScoder(repoDir: string, args: string[]): Promise<string> {
  try {
    const scoderScript = `${process.cwd()}/src/index.ts`;
    const proc = await Bun.spawn(
      ["bun", "run", scoderScript, ...args],
      {
        cwd: repoDir,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    await proc.exited;

    const stdoutBytes = await new Response(proc.stdout).arrayBuffer();
    const stderrBytes = await new Response(proc.stderr).arrayBuffer();

    return new TextDecoder().decode(stdoutBytes) + new TextDecoder().decode(stderrBytes);
  } catch (err) {
    return String(err);
  }
}

async function mktemp(pattern: string): Promise<string> {
  const proc = await $`mktemp -d ${pattern}`.quiet();
  return proc.text().then((t) => t.trim());
}

async function cleanup(): Promise<void> {
  try {
    await $`rm -rf ${TEST_BASE}`.quiet();
  } catch {
  }
}

main().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
