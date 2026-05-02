#!/usr/bin/env bash

# shellcheck disable=SC2016,SC2317
set -euo pipefail

readonly SCODER_HOME="/home/scoder"

SCODER_SCRIPT="${1:-}"
if [[ -z "${SCODER_SCRIPT}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")" && pwd -P)"
    SCODER_SCRIPT="${SCRIPT_DIR}/../scoder"
fi

if [[ ! -f "${SCODER_SCRIPT}" ]]; then
    echo "validate: scoder script not found: ${SCODER_SCRIPT}" >&2
    exit 1
fi
SCODER_SCRIPT="$(realpath "${SCODER_SCRIPT}")"

TEST_BASE="$(mktemp -d /tmp/scoder-validation.XXXXXX)"
PASSED=0
FAILED=0

cleanup_pid() {
    set +e

    local pid="$1"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
        kill "${pid}" >/dev/null 2>&1 || true
        wait "${pid}" >/dev/null 2>&1 || true
    fi
}

cleanup_repo() {
    set +e

    local repo_dir="$1"
    if [[ -d "${repo_dir}" ]]; then
        while IFS= read -r worktree_dir; do
            git -C "${repo_dir}" worktree remove --force "${worktree_dir}" >/dev/null 2>&1 || true
        done < <(git -C "${repo_dir}" worktree list --porcelain 2>/dev/null | grep '^worktree /tmp/scoder' | cut -d' ' -f2)

        while IFS= read -r branch_name; do
            git -C "${repo_dir}" branch -D "${branch_name}" >/dev/null 2>&1 || true
        done < <(git -C "${repo_dir}" branch --list 'scoder/*' 2>/dev/null | sed 's/^..//')
    fi
}

cleanup() {
    set +e

    if [[ -d "${TEST_BASE}" ]]; then
        while IFS= read -r repo_dir; do
            cleanup_repo "${repo_dir}"
        done < <(find "${TEST_BASE}" -mindepth 2 -maxdepth 2 -type d -name repo 2>/dev/null | sort)
    fi

    rm -rf "${TEST_BASE}"
}
trap cleanup EXIT

create_test_repo() {
    local case_name="$1"
    local case_dir="${TEST_BASE}/${case_name}"
    local repo_dir="${case_dir}/repo"

    mkdir -p "${repo_dir}"
    git -C "${repo_dir}" init -q
    git -C "${repo_dir}" config user.email "test@scoder"
    git -C "${repo_dir}" config user.name "scoder-test"
    echo "test" > "${repo_dir}/file.txt"
    mkdir -p "${repo_dir}/.github"
    echo "workflow" > "${repo_dir}/.github/ci.yml"
    echo "*.pyc" > "${repo_dir}/.gitignore"
    echo "{}" > "${repo_dir}/package-lock.json"
    git -C "${repo_dir}" add -A
    git -C "${repo_dir}" commit -q -m "initial"

    echo "${repo_dir}"
}

commit_repo_state() {
    local repo_dir="$1"
    local message="$2"

    git -C "${repo_dir}" add -A
    git -C "${repo_dir}" commit -q -m "${message}"
}

worktree_path_for_repo() {
    local repo_dir="$1"
    echo "/tmp/scoder/${repo_dir#/}"
}

run_scoder() {
    local repo_dir="$1"
    shift
    (cd "${repo_dir}" && "${SCODER_SCRIPT}" "$@" 2>&1) || true
}

run_scoder_in_dir() {
    local run_dir="$1"
    shift
    (cd "${run_dir}" && "${SCODER_SCRIPT}" "$@" 2>&1) || true
}

assert_match() {
    local output="$1"
    local pattern="$2"
    if echo "${output}" | grep -qE "${pattern}"; then
        return 0
    fi

    echo "    Expected pattern: ${pattern}" >&2
    echo "    Got: ${output}" >&2
    return 1
}

assert_not_match() {
    local output="$1"
    local pattern="$2"
    if echo "${output}" | grep -qE "${pattern}"; then
        echo "    Unexpected pattern: ${pattern}" >&2
        echo "    Got: ${output}" >&2
        return 1
    fi

    return 0
}

run_case() {
    local case_name="$1"
    shift

    echo ""
    echo "Test: ${case_name}"

    local repo_dir
    repo_dir="$(create_test_repo "${case_name}")"

    if "$@" "${repo_dir}"; then
        echo "  PASS"
        PASSED=$((PASSED + 1))
    else
        echo "  FAIL"
        FAILED=$((FAILED + 1))
    fi

    cleanup_repo "${repo_dir}"
    rm -rf "$(dirname "${repo_dir}")"
}

test_home_isolation() {
    local repo_dir="$1"
    local output
    output=$(run_scoder "${repo_dir}" -q /bin/bash -c 'printf "%s\n" "$HOME"')
    assert_match "${output}" "${SCODER_HOME}"
}

test_system_is_read_only() {
    local repo_dir="$1"
    local output
    output=$(run_scoder "${repo_dir}" -q /bin/bash -c 'touch /usr/bin/scoder-test 2>&1')
    assert_match "${output}" 'Read-only|Permission denied|cannot touch'
}

test_worktree_is_writable() {
    local repo_dir="$1"
    local output
    output=$(run_scoder "${repo_dir}" -q /bin/bash -c 'touch newfile.txt && echo SUCCESS')
    assert_match "${output}" 'SUCCESS'
}

test_github_is_protected() {
    local repo_dir="$1"
    local output
    output=$(run_scoder "${repo_dir}" -q /bin/bash -c 'touch .github/test 2>&1')
    assert_match "${output}" 'Read-only|Permission denied|cannot touch'
}

test_gitignore_is_protected() {
    local repo_dir="$1"
    local output
    output=$(run_scoder "${repo_dir}" -q /bin/bash -c 'echo "test" >> .gitignore 2>&1')
    assert_match "${output}" 'Read-only|Permission denied|cannot'
}

test_empty_agentreadonly_allows_workspace_writes() {
    local repo_dir="$1"
    touch "${repo_dir}/.agentreadonly"
    commit_repo_state "${repo_dir}" "add agentreadonly override"

    local output
    output=$(run_scoder "${repo_dir}" -q /bin/bash -c 'touch .github/test && echo SUCCESS')
    assert_match "${output}" 'SUCCESS'
}

test_agentreadonly_is_protected() {
    local repo_dir="$1"
    touch "${repo_dir}/.agentreadonly"
    commit_repo_state "${repo_dir}" "add agentreadonly override"

    local output
    output=$(run_scoder "${repo_dir}" -q /bin/bash -c 'echo "test" >> .agentreadonly 2>&1')
    assert_match "${output}" 'Read-only|Permission denied|cannot'
}

test_agentreadonly_home_directory_is_bound_readonly() {
    local repo_dir="$1"
    local fake_home="${TEST_BASE}/bind-home"
    local reference_dir="${fake_home}/Git/other-project"

    mkdir -p "${reference_dir}"
    echo "reference-data" > "${reference_dir}/data.txt"

    cat > "${repo_dir}/.agentreadonly" <<'EOF'
$HOME/Git/other-project
EOF
    commit_repo_state "${repo_dir}" "add home readonly bind"

    local output
    output=$(HOME="${fake_home}" run_scoder "${repo_dir}" -q /bin/bash -c 'cat /home/scoder/Git/other-project/data.txt && echo "test" >> /home/scoder/Git/other-project/data.txt 2>&1 || true')
    assert_match "${output}" 'reference-data' || return 1
    assert_match "${output}" 'Read-only|Permission denied|cannot'
}

test_agentreadonly_home_directory_must_exist() {
    local repo_dir="$1"
    local fake_home="${TEST_BASE}/missing-bind-home"

    mkdir -p "${fake_home}"

    cat > "${repo_dir}/.agentreadonly" <<'EOF'
$HOME/Git/missing-project
EOF
    commit_repo_state "${repo_dir}" "add missing home readonly bind"

    local output
    output=$(HOME="${fake_home}" run_scoder "${repo_dir}" -q /bin/true)
    assert_match "${output}" 'HOME bind must reference an existing directory'
}

test_worktree_branch_is_created() {
    local repo_dir="$1"
    run_scoder "${repo_dir}" -q /bin/bash -c 'echo READY' >/dev/null

    local branches
    branches=$(git -C "${repo_dir}" branch --list 'scoder/*' 2>/dev/null || true)
    [[ -n "${branches}" ]]
}

test_existing_scoder_worktree_is_reused() {
    local repo_dir="$1"
    run_scoder "${repo_dir}" -q /bin/bash -c 'echo READY' >/dev/null

    local worktree_dir
    worktree_dir="$(worktree_path_for_repo "${repo_dir}")"
    echo "dirty" > "${worktree_dir}/reuse.txt"

    local output
    output=$(run_scoder_in_dir "${worktree_dir}" --dry-run /bin/true)
    assert_match "${output}" 'Already in scoder worktree'
    assert_not_match "${output}" 'You have uncommitted changes'
}

test_symlinked_agents_skills_are_available() {
    local repo_dir="$1"
    local fake_home="${TEST_BASE}/agents-home"
    local skill_target="${TEST_BASE}/linked-skill"

    mkdir -p "${fake_home}/.agents/skills" "${skill_target}"
    cat > "${skill_target}/SKILL.md" <<'EOF'
---
name: linked-skill
description: 'Test skill for validation.'
---
EOF
    ln -s "${skill_target}" "${fake_home}/.agents/skills/linked-skill"

    local output
    output=$(HOME="${fake_home}" run_scoder "${repo_dir}" -q /bin/bash -c 'test -f /home/scoder/.agents/skills/linked-skill/SKILL.md && echo SUCCESS')
    assert_match "${output}" 'SUCCESS'
}

test_sandbox_agents_md_overlay_is_visible() {
    local repo_dir="$1"

    cat > "${repo_dir}/AGENTS.md" <<'EOF'
# Repo instructions
EOF
    commit_repo_state "${repo_dir}" "add agents instructions"

    local output
    output=$(run_scoder "${repo_dir}" -q /bin/bash -c 'grep -q "Repo instructions" AGENTS.md && grep -q "You are running inside a scoder sandbox." AGENTS.md && echo SUCCESS')
    assert_match "${output}" 'SUCCESS' || return 1

    if grep -q "You are running inside a scoder sandbox." "${repo_dir}/AGENTS.md"; then
        echo "    Host AGENTS.md was modified unexpectedly" >&2
        return 1
    fi

    return 0
}

test_host_loopback_is_blocked() {
    local repo_dir="$1"
    local port_file="${TEST_BASE}/loopback-port"
    local server_pid=""

    python3 -u - <<'PY' > "${port_file}" &
import http.server
import socketserver


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"SUCCESS")

    def log_message(self, *args):
        pass


with socketserver.TCPServer(("127.0.0.1", 0), Handler) as httpd:
    print(httpd.server_address[1], flush=True)
    httpd.serve_forever()
PY
    server_pid=$!

    local port=""
    local i=0
    while [[ ! -s "${port_file}" && "${i}" -lt 20 ]]; do
        sleep 0.2
        i=$((i + 1))
    done

    if [[ ! -s "${port_file}" ]]; then
        echo "    Loopback test server did not start" >&2
        cleanup_pid "${server_pid}"
        return 1
    fi

    read -r port < "${port_file}"

    local output
    output=$(run_scoder "${repo_dir}" -q /bin/bash -c "curl -fsS --max-time 2 http://127.0.0.1:${port}/ 2>&1 || echo BLOCKED")

    cleanup_pid "${server_pid}"
    assert_match "${output}" 'BLOCKED'
}

test_llm_port_allows_host_loopback() {
    local repo_dir="$1"
    local port_file="${TEST_BASE}/llm-port"
    local server_pid=""

    python3 -u - <<'PY' > "${port_file}" &
import http.server
import socketserver


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"SUCCESS")

    def log_message(self, *args):
        pass


with socketserver.TCPServer(("127.0.0.1", 0), Handler) as httpd:
    print(httpd.server_address[1], flush=True)
    httpd.serve_forever()
PY
    server_pid=$!

    local port=""
    local i=0
    while [[ ! -s "${port_file}" && "${i}" -lt 20 ]]; do
        sleep 0.2
        i=$((i + 1))
    done

    if [[ ! -s "${port_file}" ]]; then
        echo "    LLM test server did not start" >&2
        cleanup_pid "${server_pid}"
        return 1
    fi

    read -r port < "${port_file}"

    local output
    output=$(run_scoder "${repo_dir}" -q "--llm-port=${port}" /bin/bash -c "curl -fsS --max-time 2 http://127.0.0.1:${port}/")

    cleanup_pid "${server_pid}"
    assert_match "${output}" 'SUCCESS'
}

test_outbound_dns_and_https_work() {
    local repo_dir="$1"
    local output
    output=$(run_scoder "${repo_dir}" -q /bin/bash -c 'python3 - <<'"'"'PY'"'"'
import socket
import urllib.request

socket.getaddrinfo("example.com", 443)
with urllib.request.urlopen("https://example.com", timeout=10) as response:
    if response.status != 200:
        raise SystemExit(f"unexpected status: {response.status}")

print("SUCCESS")
PY')
    assert_match "${output}" 'SUCCESS'
}

test_dry_run_uses_pasta_launcher() {
    local repo_dir="$1"
    local output
    output=$(run_scoder "${repo_dir}" --dry-run /bin/true)
    assert_match "${output}" 'pasta'
}

echo "====== scoder validation tests ======"

run_case "home-isolation" test_home_isolation
run_case "system-read-only" test_system_is_read_only
run_case "worktree-writable" test_worktree_is_writable
run_case "github-protected" test_github_is_protected
run_case "gitignore-protected" test_gitignore_is_protected
run_case "empty-agentreadonly-allows-writes" test_empty_agentreadonly_allows_workspace_writes
run_case "agentreadonly-protected" test_agentreadonly_is_protected
run_case "agentreadonly-home-directory-readonly" test_agentreadonly_home_directory_is_bound_readonly
run_case "agentreadonly-home-directory-must-exist" test_agentreadonly_home_directory_must_exist
run_case "worktree-branch-created" test_worktree_branch_is_created
run_case "existing-scoder-worktree-reused" test_existing_scoder_worktree_is_reused
run_case "symlinked-agents-skills-available" test_symlinked_agents_skills_are_available
run_case "sandbox-agents-md-overlay-visible" test_sandbox_agents_md_overlay_is_visible
run_case "host-loopback-blocked" test_host_loopback_is_blocked
run_case "llm-port-allows-host-loopback" test_llm_port_allows_host_loopback
run_case "outbound-dns-and-https-work" test_outbound_dns_and_https_work
run_case "dry-run-uses-pasta" test_dry_run_uses_pasta_launcher

echo ""
if [[ "${FAILED}" -eq 0 ]]; then
    echo "All ${PASSED} tests passed"
    exit 0
fi

echo "${FAILED} test(s) failed, ${PASSED} passed" >&2
exit 1
