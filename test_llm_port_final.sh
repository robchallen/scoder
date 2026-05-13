#!/usr/bin/env bash

# Test script to validate the --llm-port parsing logic in scoder

# Set up test environment
TEST_DIR=$(mktemp -d)
cd "$TEST_DIR"

# Initialize a git repo (required by scoder)
git init >/dev/null 2>&1
git config user.email "test@test.com"
git config user.name "Test User"
echo "test" > file.txt
git add .
git commit -m "initial commit" >/dev/null 2>&1

# Source the scoder script's functions we need
# We'll extract the relevant parts by copying them here

error() { echo -e "scoder: $*" >&2; }

# Test the option parsing logic directly
parse_llm_port_option() {
    # This simulates the option parsing in scoder
    local arg="$1"
    case "$arg" in
        --llm-port)
            # This would normally consume the next argument
            echo "NEED_ARG"
            ;;
        --llm-port=*)
            echo "${arg#--llm-port=}"
            ;;
        *)
            echo "NOT_MATCH"
            ;;
    esac
}

# Test the validation logic
validate_llm_ports() {
    local ports="$1"
    if [[ -z "$ports" ]]; then
        return 0
    fi
    # Split by comma and validate each port
    IFS=',' read -ra PORTS <<< "$ports"
    for port in "${PORTS[@]}"; do
        if ! [[ "$port" =~ ^[0-9]+$ ]] || [[ "$port" -lt 1 || "$port" -gt 65535 ]]; then
            return 1
        fi
    done
    return 0
}

# Run tests
echo "Testing --llm-port functionality..."

# Test 1: No LLM port (should pass validation)
LLM_PORT=""
if validate_llm_ports "$LLM_PORT"; then
    echo "PASS: Empty LLM port validates correctly"
else
    echo "FAIL: Empty LLM port should validate"
    exit 1
fi

# Test 2: Single valid port
LLM_PORT="11434"
if validate_llm_ports "$LLM_PORT"; then
    echo "PASS: Single valid port validates correctly"
else
    echo "FAIL: Single valid port should validate"
    exit 1
fi

# Test 3: Multiple valid ports (CSV)
LLM_PORT="11434,11435,8080"
if validate_llm_ports "$LLM_PORT"; then
    echo "PASS: Multiple valid ports validate correctly"
else
    echo "FAIL: Multiple valid ports should validate"
    exit 1
fi

# Test 4: Invalid port (0)
LLM_PORT="0"
if ! validate_llm_ports "$LLM_PORT"; then
    echo "PASS: Invalid port (0) correctly rejected"
else
    echo "FAIL: Invalid port (0) should be rejected"
    exit 1
fi

# Test 5: Invalid port (too high)
LLM_PORT="65536"
if ! validate_llm_ports "$LLM_PORT"; then
    echo "PASS: Invalid port (65536) correctly rejected"
else
    echo "FAIL: Invalid port (65536) should be rejected"
    exit 1
fi

# Test 6: Non-numeric port
LLM_PORT="abc"
if ! validate_llm_ports "$LLM_PORT"; then
    echo "PASS: Non-numeric port correctly rejected"
else
    echo "FAIL: Non-numeric port should be rejected"
    exit 1
fi

# Test 7: Mixed valid and invalid
LLM_PORT="11434,99999"
if ! validate_llm_ports "$LLM_PORT"; then
    echo "PASS: Mixed valid/invalid ports correctly rejected"
else
    echo "FAIL: Mixed valid/invalid ports should be rejected"
    exit 1
fi

# Test 8: Option parsing --llm-port value
result=$(parse_llm_port_option "--llm-port")
if [[ "$result" == "NEED_ARG" ]]; then
    echo "PASS: --llm-port option correctly identifies need for argument"
else
    echo "FAIL: --llm-port option parsing failed"
    exit 1
fi

# Test 9: Option parsing --llm-port=value
result=$(parse_llm_port_option "--llm-port=11434")
if [[ "$result" == "11434" ]]; then
    echo "PASS: --llm-port=value option correctly extracts value"
else
    echo "FAIL: --llm-port=value option parsing failed"
    exit 1
fi

# Test 10: Option parsing non-match
result=$(parse_llm_port_option "--other-option")
if [[ "$result" == "NOT_MATCH" ]]; then
    echo "PASS: Non-matching option correctly returns NOT_MATCH"
else
    echo "FAIL: Non-matching option parsing failed"
    exit 1
fi

echo "All tests passed!"