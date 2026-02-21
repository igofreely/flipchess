#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

to_abs_path() {
	local input_path="$1"
	if [[ -z "${input_path}" ]]; then
		echo ""
		return 0
	fi

	if [[ "${input_path}" = /* ]]; then
		echo "${input_path}"
		return 0
	fi

	echo "${ROOT_DIR}/${input_path}"
}

export MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
export MYSQL_PORT="${MYSQL_PORT:-3306}"
export MYSQL_USER="${MYSQL_USER:-root}"
export MYSQL_PASSWORD="${MYSQL_PASSWORD:-}"
export MYSQL_DATABASE="${MYSQL_DATABASE:-flipchess}"

detect_pikafish_path() {
	local candidates=(
		"${ROOT_DIR}/../Pikafish-jieqi-old/src/PikaJieQi"
		"${ROOT_DIR}/../Pikafish-jieqi/src/pikafish"
	)

	local path
	for path in "${candidates[@]}"; do
		if [[ -x "${path}" ]]; then
			echo "${path}"
			return 0
		fi
	done

	return 1
}

detect_jieqi_old_path() {
	local path="${ROOT_DIR}/../Pikafish-jieqi-old/src/PikaJieQi"
	if [[ -x "${path}" ]]; then
		echo "${path}"
		return 0
	fi
	return 1
}

probe_engine_ready() {
	local engine_path="$1"
	local evalfile_path="${2:-}"
	if [[ ! -x "${engine_path}" ]]; then
		return 1
	fi

	local cmd='uci\n'
	if [[ -n "${evalfile_path}" ]]; then
		cmd+="setoption name EvalFile value ${evalfile_path}\\n"
	fi
	cmd+='isready\nucinewgame\ngo depth 1 movetime 200\nquit\n'

	local output
	output="$(printf "%b" "${cmd}" | "${engine_path}" 2>&1 || true)"

	if grep -qiE 'ERROR: Network evaluation parameters compatible with the engine must be available|was not loaded successfully|engine will be terminated now' <<<"${output}"; then
		return 1
	fi

	if grep -q 'bestmove ' <<<"${output}"; then
		return 0
	fi

	return 1
}

if [[ -z "${PIKAFISH_JIEQI_PATH:-}" ]]; then
	if detected_path="$(detect_pikafish_path)"; then
		export PIKAFISH_JIEQI_PATH="${detected_path}"
		echo "[server-start] auto detected PIKAFISH_JIEQI_PATH=${PIKAFISH_JIEQI_PATH}"
	fi
fi

if [[ -n "${PIKAFISH_JIEQI_PATH:-}" ]]; then
	export PIKAFISH_JIEQI_PATH="$(to_abs_path "${PIKAFISH_JIEQI_PATH}")"
fi

if [[ -n "${PIKAFISH_JIEQI_PATH:-}" && -z "${PIKAFISH_EVALFILE_PATH:-}" ]]; then
	default_evalfile="$(dirname "${PIKAFISH_JIEQI_PATH}")/pikafish.nnue"
	if [[ -f "${default_evalfile}" ]]; then
		export PIKAFISH_EVALFILE_PATH="${default_evalfile}"
		echo "[server-start] auto detected PIKAFISH_EVALFILE_PATH=${PIKAFISH_EVALFILE_PATH}"
	fi
fi

if [[ -n "${PIKAFISH_EVALFILE_PATH:-}" ]]; then
	export PIKAFISH_EVALFILE_PATH="$(to_abs_path "${PIKAFISH_EVALFILE_PATH}")"
fi

if [[ -n "${PIKAFISH_JIEQI_PATH:-}" ]]; then
	if ! probe_engine_ready "${PIKAFISH_JIEQI_PATH}" "${PIKAFISH_EVALFILE_PATH:-}"; then
		if fallback_engine_path="$(detect_jieqi_old_path)"; then
			if [[ "${fallback_engine_path}" != "${PIKAFISH_JIEQI_PATH}" ]]; then
				echo "[server-start] current Pikafish failed preflight, fallback to jieqi-old: ${fallback_engine_path}"
				export PIKAFISH_JIEQI_PATH="${fallback_engine_path}"
				fallback_evalfile="$(dirname "${PIKAFISH_JIEQI_PATH}")/pikafish.nnue"
				if [[ -f "${fallback_evalfile}" ]]; then
					export PIKAFISH_EVALFILE_PATH="${fallback_evalfile}"
					echo "[server-start] fallback EvalFile=${PIKAFISH_EVALFILE_PATH}"
				else
					unset PIKAFISH_EVALFILE_PATH
				fi
			fi
		fi
	fi
fi

export PIKAFISH_THREADS="${PIKAFISH_THREADS:-1}"
export PIKAFISH_HASH_MB="${PIKAFISH_HASH_MB:-64}"

npm run server:start
