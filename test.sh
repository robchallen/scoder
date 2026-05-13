#!/usr/bin/env bash

error() { echo -e "scoder: $*" >&2; }

LLM_PORT=""

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
                index=$((index + 1))
                ;;
        esac
    done
    return 0
}

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

# Test
LLM_PORT=""
process_args --llm-port 0
echo "process_args returned $?"
echo "LLM_PORT is '$LLM_PORT'"
validate_llm_port
echo "validate_llm_port returned $?"
