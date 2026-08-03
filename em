#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# --- Configuration & Paths ---
EM_DIR=".agents/em"
RUN_LOG="$EM_DIR/run-output"
TEST_LOG="$EM_DIR/test-output"
DOC_LOG="$EM_DIR/docs-output"
CHECK_LOG="$EM_DIR/check-output"
DESIGN_LOG="$EM_DIR/design-output"

# --- Helper Functions ---
ensure_em_dir() {
    mkdir -p "$EM_DIR"
}

show_help() {
    echo "Usage: em <command> [options]"
    echo ""
    echo "Supported sub-commands:"
    echo "  setup   Installs prerequisites, checks runtime versions, and resolves dependencies"
    echo "  run     Builds and executes the project (logs to $RUN_LOG)"
    echo "  test    Builds and runs all automated tests with coverage (outputs to terminal and $TEST_LOG)"
    echo "  doc     Checks design docs: broken links, test-case and feature counts"
    echo "          (fails on any mismatch; full report in $DOC_LOG)"
    echo "  check   Runs typecheck and lint (fails on either; duplication is advisory)"
    echo "          (full report in $CHECK_LOG)"
    echo "  design  Runs design consistency checks (logs report to $EM_DIR/design-output)"
    echo "  bump    Updates the version number of the project"
    echo "  help    Show this help message"
}

# --- Sub-command Implementations ---

cmd_setup() {
    echo "Starting 'setup' command..."

    if ! command -v bun &> /dev/null; then
        echo "WARNING: 'bun' is not found. Install from https://bun.sh"
        exit 1
    fi

    echo "Checking system dependencies..."
    if ! command -v bwrap &> /dev/null; then
        echo "WARNING: 'bwrap' (bubblewrap) is not installed."
        echo "         Install with: sudo apt install bubblewrap"
    fi

    if ! command -v pasta &> /dev/null; then
        echo "WARNING: 'pasta' is not installed."
        echo "         Install with: sudo apt install passt"
    fi

    echo "Installing project dependencies..."
    bun install

    echo "Setup complete."
}

cmd_run() {
    echo "Starting 'run' command..."
    ensure_em_dir

    echo "Building scoder..." | tee "$RUN_LOG"
    bun run build >> "$RUN_LOG" 2>&1
    echo "scoder built to ./scoder" >> "$RUN_LOG"
    echo "Run complete. Output logged to $RUN_LOG"
}

cmd_test() {
    echo "Starting 'test' command..."
    ensure_em_dir

    echo "Running tests..." | tee "$TEST_LOG"

    # Run tests and capture output
    # Note: Integration tests run scoder via Bun.spawn(), which executes in a separate
    # process. Coverage only tracks code in the same process, so source files aren't
    # covered when using process isolation. For true coverage, tests would import
    # and call scoder functions directly.
    #
    # PIPESTATUS[0], not the pipeline's own status: a pipeline reports the exit
    # code of its LAST command, so `bun test | tee` always looked successful and
    # this command could never report a test failure.
    local exit_code
    bun test 2>&1 | tee -a "$TEST_LOG"
    exit_code=${PIPESTATUS[0]}

    echo ""
    if [ "$exit_code" -ne 0 ]; then
        echo "Test suite FAILED (exit $exit_code). Output saved to $TEST_LOG"
    else
        echo "Test suite passed. Output saved to $TEST_LOG"
    fi

    return "$exit_code"
}

# Emit "file -> link" for every relative link target that does not exist.
# Covers .md, .ts and .sh targets; http(s) links are skipped, as are the
# anchor fragments after '#'. Repo-absolute links (/src/...) resolve from the
# repo root, matching the IMPLEMENTED_BY convention.
find_broken_links() {
    find design architecture -name "*.md" -type f 2>/dev/null | sort | while IFS= read -r file; do
        dir=$(dirname "$file")
        grep -oE '\]\([^) ]+\.(md|ts|sh)(#[^)]*)?\)' "$file" 2>/dev/null |
            sed -E 's/^\]\(//; s/\)$//; s/#.*$//' |
            while IFS= read -r link; do
                case "$link" in
                    http://*|https://*) continue ;;
                    /*) resolved=".$link" ;;
                    *) resolved="$dir/$link" ;;
                esac
                [ -e "$resolved" ] || echo "$file -> $link"
            done
    done
}

# Test cases documented in the validation suite vs tests actually defined.
# Counts top-level test declarations, including test.failing and test.skipIf.
count_documented_tests() {
    grep -cE '^### [0-9]+\.' design/test-scripts/validation-suite.md 2>/dev/null || echo 0
}

count_implemented_tests() {
    grep -cE '^test' tests/scoder.test.ts 2>/dev/null || echo 0
}

cmd_doc() {
    echo "Starting 'doc' command..."
    ensure_em_dir

    local broken broken_count documented implemented features scoped status=0

    broken=$(find_broken_links)
    broken_count=$(printf '%s' "$broken" | grep -c . || true)
    documented=$(count_documented_tests)
    implemented=$(count_implemented_tests)
    features=$(find design/features -name "*.md" -type f 2>/dev/null | wc -l)
    scoped=$(grep -cE '^\[HAS_FEATURE\]' design/SCOPE.md 2>/dev/null || echo 0)

    {
        echo "Documentation Report - $(date)"
        echo "-----------------------------------"
        echo ""
        echo "Broken links: $broken_count"
        if [ "$broken_count" -gt 0 ]; then
            printf '%s\n' "$broken" | sed 's/^/  BROKEN /'
        fi
        echo ""
        echo "Test cases documented: $documented"
        echo "Tests implemented:     $implemented"
        if [ "$documented" -ne "$implemented" ]; then
            echo "  MISMATCH: validation-suite.md and tests/scoder.test.ts disagree"
        fi
        echo ""
        echo "Feature docs:            $features"
        echo "HAS_FEATURE in SCOPE.md: $scoped"
        if [ "$features" -ne "$scoped" ]; then
            echo "  MISMATCH: a feature doc is missing from SCOPE.md, or vice versa"
        fi
        echo ""
        echo "Frontmatter status values:"
        grep -rh "^status:" design architecture 2>/dev/null | sort | uniq -c | sed 's/^/  /'
        echo ""
        echo "Design documents:"
        find design -name "*.md" -type f | sort | sed 's/^/  /'
        echo ""
        echo "Architecture documents:"
        find architecture -name "*.md" -type f | sort | sed 's/^/  /'
    } > "$DOC_LOG"

    # Summary to the terminal, detail to the log
    echo "  broken links: $broken_count"
    if [ "$broken_count" -gt 0 ]; then
        printf '%s\n' "$broken" | sed 's/^/    BROKEN /'
        status=1
    fi
    echo "  test cases: $documented documented, $implemented implemented"
    [ "$documented" -ne "$implemented" ] && echo "    MISMATCH" && status=1
    echo "  features: $features docs, $scoped in SCOPE.md"
    [ "$features" -ne "$scoped" ] && echo "    MISMATCH" && status=1

    echo "Documentation check complete. Full report in $DOC_LOG"
    return $status
}

# run_check <label> <gate|info> <command...>
#
# Runs a check, appends its full output to the log, and prints a one-line
# verdict. A 'gate' check returning non-zero fails the run; an 'info' check
# only reports. A missing tool is reported as SKIPPED rather than silently
# passing — the previous implementation conflated "tool absent" with "no
# issues found", which meant biome finding problems was reported as success.
run_check() {
    local label="$1" mode="$2"
    shift 2
    local out status=0

    if ! command -v "$1" > /dev/null 2>&1; then
        echo "  $label: SKIPPED ($1 not found)"
        {
            echo ""
            echo "=== $label ==="
            echo "SKIPPED: $1 not found"
        } >> "$CHECK_LOG"
        return 0
    fi

    out=$("$@" 2>&1) || status=$?

    {
        echo ""
        echo "=== $label (exit $status) ==="
        printf '%s\n' "$out"
    } >> "$CHECK_LOG"

    if [ "$status" -eq 0 ]; then
        echo "  $label: ok"
        return 0
    fi

    # Surface the lines that actually say what went wrong
    local summary
    summary=$(printf '%s\n' "$out" | grep -E '^Found |error TS|^error' | head -5 || true)

    if [ "$mode" = "gate" ]; then
        echo "  $label: FAILED (exit $status)"
    else
        echo "  $label: issues found (informational)"
    fi

    if [ -n "$summary" ]; then
        printf '%s\n' "$summary" | sed 's/^/    /'
    fi

    [ "$mode" = "gate" ] && return 1
    return 0
}

cmd_check() {
    echo "Starting 'check' command..."
    ensure_em_dir

    local status=0

    {
        echo "Code Quality Report - $(date)"
        echo "-----------------------------------"
    } > "$CHECK_LOG"

    run_check "typecheck  " gate bun run typecheck || status=1
    run_check "lint/format" gate bunx biome check src tests || status=1

    # Duplication is advisory: jscpd exits 0 regardless unless a --threshold is
    # configured, so it cannot gate as things stand.
    run_check "duplication" info bunx jscpd src tests || true

    {
        echo ""
        echo "=== Source files ==="
        find src -name "*.ts" -type f | sort
        echo ""
        echo "=== Test files ==="
        find tests -name "*.ts" -type f | sort
    } >> "$CHECK_LOG"

    if [ "$status" -ne 0 ]; then
        echo "Code quality checks FAILED. Full report in $CHECK_LOG"
    else
        echo "Code quality checks passed. Full report in $CHECK_LOG"
    fi

    return $status
}

cmd_design() {
    echo "Starting 'design' command..."
    ensure_em_dir

    DESIGN_LOG="$EM_DIR/design-output"

    echo "Running design consistency checks..." > "$DESIGN_LOG"

    # Try multiple possible locations for design-check.R
    DESIGN_SCRIPT=""
    if [ -f ".agents/skills/practice-continuous-evolutionary-design/scripts/design-check.R" ]; then
        DESIGN_SCRIPT=".agents/skills/practice-continuous-evolutionary-design/scripts/design-check.R"
    elif [ -f "$HOME/.agents/skills/practice-continuous-evolutionary-design/scripts/design-check.R" ]; then
        DESIGN_SCRIPT="$HOME/.agents/skills/practice-continuous-evolutionary-design/scripts/design-check.R"
    fi

    if [ -n "$DESIGN_SCRIPT" ]; then
        Rscript "$DESIGN_SCRIPT" --dir=. 2>&1 | tee -a "$DESIGN_LOG"
    else
        echo "[WARNING] design-check.R not found - skipping automated design checks." | tee -a "$DESIGN_LOG"
    fi

    echo "Design check complete. Output logged to $DESIGN_LOG"
}

cmd_bump() {
    echo "Bumping code version..."

    if [ -f "package.json" ]; then
        CURRENT_VERSION=$(grep '"version"' package.json | sed 's/.*"version": "\(.*\)".*/\1/')
        echo "Current version: $CURRENT_VERSION"

        # Split version and bump patch
        IFS='.' read -ra PARTS <<< "$CURRENT_VERSION"
        PATCH=${PARTS[2]}
        NEW_PATCH=$((PATCH + 1))
        NEW_VERSION="${PARTS[0]}.${PARTS[1]}.$NEW_PATCH"

        echo "New version: $NEW_VERSION"

        # Update package.json (macOS and Linux compatible)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json
        else
            sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json
        fi
    else
        echo "ERROR: package.json not found" >&2
        exit 1
    fi
}

# --- Main Argument Parsing ---

if [ $# -eq 0 ]; then
    show_help
    exit 0
fi

COMMAND="$1"
shift

case "$COMMAND" in
    setup)
        cmd_setup "$@"
        ;;
    run)
        cmd_run "$@"
        ;;
    test)
        cmd_test "$@"
        ;;
    doc)
        cmd_doc "$@"
        ;;
    check)
        cmd_check "$@"
        ;;
    design)
        cmd_design "$@"
        ;;
    bump)
        cmd_bump "$@"
        ;;
    --help|help|-h)
        show_help
        ;;
    *)
        echo "Error: Unknown command '$COMMAND'" >&2
        echo "" >&2
        show_help >&2
        exit 1
        ;;
esac
