#!/usr/bin/env bash

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

echo "====== scoder validation tests ======"

run_case "home-isolation" test_home_isolation
run_case "system-read-only" test_system_is_read_only
run_case "worktree-writable" test_worktree_is_writable
run_case "github-protected" test_github_is_protected
run_case "gitignore-protected" test_gitignore_is_protected
run_case "empty-agentreadonly-allows-writes" test_empty_agentreadonly_allows_workspace_writes
run_case "agentreadonly-protected" test_agentreadonly_is_protected
run_case "worktree-branch-created" test_worktree_branch_is_created
run_case "existing-scoder-worktree-reused" test_existing_scoder_worktree_is_reused
run_case "symlinked-agents-skills-available" test_symlinked_agents_skills_are_available
run_case "sandbox-agents-md-overlay-visible" test_sandbox_agents_md_overlay_is_visible

echo ""
if [[ "${FAILED}" -eq 0 ]]; then
    echo "All ${PASSED} tests passed"
    exit 0
fi

echo "${FAILED} test(s) failed, ${PASSED} passed" >&2
exit 1
