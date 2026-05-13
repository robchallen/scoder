#!/usr/bin/env bash

# Test script to validate the --llm-port parsing logic

# Source the scoder script but only the parts we need
# We'll copy the relevant functions and variables into this test

# Set up the environment as if we are in the scoder script
QUIET=0
CONFIGURE_APPARMOR=0
INSTALL_DEPENDENCIES=0
DRY_RUN=0
LLM_PORT=""
TOOL_NAME=""
TOOL_ARGS=()

# We need to define the error function to avoid errors when calling error
error() { echo -e "scoder: $*" >&2; }

# We'll also need to define the detect_default_llm_port function, but we can leave it empty for this test
detect_default_llm_port() {
    return 0
}

# Now, we'll copy the option parsing and validation logic from the scoder script
# but we'll adjust it to not exit the script on error, instead we'll set a flag

# We'll create a function that processes the arguments and sets LLM_PORT
process_args() {
    local args=("$@")
    local index=0
    while [[ $index -lt ${#args[@]} ]]; do
        local arg="${args[$index]}"
        case "$arg" in
            --llm-port)
                if [[ $((index + 1)) -ge ${#args[@]} ]]; then
                    error "--llm-port requires a port number"
                    return 1
                fi
                LLM_PORT="${args[$((index + 1))]}"
                index=$((index + 2))
                ;;
            --llm-port=*)
                LLM_PORT="${arg#--llm-port=}"
                index=$((index + 1))
                ;;
            *)
                # For the purpose of this test, we ignore other arguments
                index=$((index + 1))
                ;;
        esac
    done
    return 0
}

# Validation function for LLM_PORT
validate_llm_port() {
    if [[ -n "${LLM_PORT}" ]]; then
        # Split by comma and validate each port
        IFS=',' read -ra PORTS <<< "${LLM_PORT}"
        for port in "${PORTS[@]}"; do
            if ! [[ "${port}" =~ ^[0-9]+$ ]] || [[ "${port}" -lt 1 || "${port}" -gt 65535 ]]; then
                error "--llm-port must be a comma-separated list of integers between 1 and 65535"
                return 1
            fi
        done
    fi
    return 0
}

# Test cases
test_case() {
    local description="$1"
    local input="$2"
    local expected_result="$3"  # 0 for success, 1 for failure
    local expected_error_contains="$4"  # optional

    LLM_PORT=""
    process_args $input
    local result=$?
    if [[ $result -ne $expected_result ]]; then
        echo "FAIL: $description - expected exit code $expected_result, got $result"
        return 1
    fi

    if [[ $expected_result -eq 1 && -n "$expected_error_contains" ]]; then
        # We cannot easily capture the error output in this setup, so we'll skip for now
        :
    fi

    if [[ $expected_result -eq 0 ]]; then
        validate_llm_port
        result=$?
        if [[ $result -ne 0 ]]; then
            echo "FAIL: $description - validation failed"
            return 1
        fi
    fi

    echo "PASS: $description"
    return 0
}

# Run test cases
echo "Testing --llm-port parsing..."

# Test 1: No --llm-port
test_case "No --llm-port" "" 0 || exit 1

# Test 2: Single port
test_case "Single port" "--llm-port 11434" 0 || exit 1
test_case "Single port with equals" "--llm-port=11434" 0 || exit 1

# Test 3: Multiple ports (CSV)
test_case "Multiple ports" "--llm-port 11434,11435" 0 || exit 1
test_case "Multiple ports with equals" "--llm-port=11434,11435" 0 || exit 1

# Test 4: Invalid port (too low)
test_case "Invalid port (0)" "--llm-port 0" 1 || exit 1
test_case "Invalid port (0) with equals" "--llm-port=0" 1 || exit 1

# Test 5: Invalid port (too high)
test_case "Invalid port (65536)" "--llm-port 65536" 1 || exit 1
test_case "Invalid port (65536) with equals" "--llm-port=65536" 1 || exit 1

# Test 6: Non-numeric
test_case "Non-numeric port" "--llm-port abc" 1 || exit 1
test_case "Non-numeric port with equals" "--llm-port=abc" 1 || exit 1

# Test 7: Mixed valid and invalid
test_case "Mixed valid and invalid" "--llm-port 11434,99999" 1 || exit 1
test_case "Mixed valid and invalid with equals" "--llm-port=11434,99999" 1 || exit 1

# Test 8: Empty string (should be invalid because it's not a number)
test_case "Empty string in CSV" "--llm-port 11434," 1 || exit 1
test_case "Empty string in CSV with equals" "--llm-port=11434," 1 || exit 1

echo "All tests passed!"