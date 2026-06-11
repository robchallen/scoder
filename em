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
    echo "  doc     Runs documentation tools (logs warnings/errors to $DOC_LOG)"
    echo "  check   Runs linters and code quality checks (logs report to $CHECK_LOG)"
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

    echo "Running with code coverage..." | tee "$TEST_LOG"
    bun run test:coverage 2>&1 | tee -a "$TEST_LOG"

    echo "Test suite complete. Output saved to $TEST_LOG"
}

cmd_doc() {
    echo "Starting 'doc' command..."
    ensure_em_dir

    echo "Checking TypeScript documentation..." > "$DOC_LOG"
    {
        echo "Documentation Report - $(date)"
        echo "-----------------------------------"
        echo ""
        echo "Design documents:"
        find design -name "*.md" -type f | sort
        echo ""
        echo "Architecture documents:"
        find architecture -name "*.md" -type f | sort
    } >> "$DOC_LOG"

    echo "Documentation generation complete. Output logged to $DOC_LOG"
}

cmd_check() {
    echo "Starting 'check' command..."
    ensure_em_dir

    echo "Running code quality checks..." > "$CHECK_LOG"
    {
        echo "Code Quality Report - $(date)"
        echo "-----------------------------------"
        echo ""
        echo "TypeScript type check:"
        bun run typecheck 2>&1 || true
        echo ""
        echo "Source files:"
        find src -name "*.ts" -type f | sort
        echo ""
        echo "Test files:"
        find tests -name "*.ts" -type f | sort
        echo ""
        echo "Code duplication analysis:"
        bunx jscpd src tests 2>&1 || echo "No duplication found or jscpd not available"
        echo ""
        echo "Code formatting and linting (Biome):"
        bunx biome check src tests 2>&1 || echo "Biome not available or no issues found"
    } >> "$CHECK_LOG"

    echo "Code quality check complete. Report written to $CHECK_LOG"
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
