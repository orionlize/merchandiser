#!/usr/bin/env bash
# Blue-green deploy for docker compose.
#
#   ./deploy.sh [deploy]   build the idle color from this checkout and switch to it
#   ./deploy.sh rollback   switch back to the previous color (its stopped container)
#   ./deploy.sh status     show which color is live
#
# How a switch works:
#   1. build and start the idle color; it stands by (healthy, not ready),
#      because the live color holds /data/engine.lock
#   2. stop the live color; it releases the lock as it exits
#   3. the new color takes the lock, backs up and migrates the database,
#      restores tasks and turns ready; the gateway sends traffic to it
# Copy trading pauses only for steps 2-3 (seconds). Web requests wait at the
# gateway in the meantime. If the new color is not ready in time, the old one
# is started again.
set -euo pipefail
cd "$(dirname "$0")"

export COMPOSE_PROFILES=blue,green
READY_TIMEOUT=${READY_TIMEOUT:-180}
STOP_TIMEOUT=${STOP_TIMEOUT:-60}

dc() { docker compose "$@"; }
log() { printf '\033[1m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

other() { [ "$1" = blue ] && echo green || echo blue; }
running() { [ -n "$(dc ps -q --status running "$1" 2>/dev/null)" ]; }
exists() { [ -n "$(dc ps -aq "$1" 2>/dev/null)" ]; }
# probe COLOR PATH: true when the container answers 200 on PATH.
probe() { running "$1" && dc exec -T "$1" wget -qO /dev/null -T 2 "http://127.0.0.1:8686/$2" >/dev/null 2>&1; }

# The color currently serving (holding the data directory), or nothing.
live() {
	local c
	for c in blue green; do
		if probe "$c" readyz; then
			echo "$c"
			return
		fi
	done
}

# wait_for COLOR PATH SECONDS
wait_for() {
	local end=$((SECONDS + $3))
	while ((SECONDS < end)); do
		probe "$1" "$2" && return 0
		running "$1" || { sleep 1; running "$1" || return 1; }
		sleep 1
	done
	return 1
}

# Deployments from before blue-green ran a single `merchandiser` service that
# does not take the engine lock: it must be gone before any color starts, or
# both would trade at once.
migrate_legacy() {
	local ids
	ids=$(docker ps -aq --filter "label=com.docker.compose.project.working_dir=$PWD" --filter "label=com.docker.compose.service=merchandiser")
	[ -z "$ids" ] && return 0
	log "found the pre-blue-green 'merchandiser' container; replacing it (brief downtime, once)"
	# shellcheck disable=SC2086
	docker stop -t "$STOP_TIMEOUT" $ids >/dev/null
	# shellcheck disable=SC2086
	docker rm $ids >/dev/null
}

cmd_status() {
	local c state
	for c in blue green; do
		if probe "$c" readyz; then state="live"
		elif probe "$c" healthz; then state="standby"
		elif running "$c"; then state="starting"
		elif exists "$c"; then state="stopped"
		else state="absent"
		fi
		printf '%-6s %s\n' "$c" "$state"
	done
}

cmd_deploy() {
	local cur target
	cur=$(live)
	target=$( [ -n "$cur" ] && other "$cur" || echo blue )
	log "live: ${cur:-none} → deploying to $target"

	dc build "$target"
	migrate_legacy
	dc up -d gateway

	if [ -z "$cur" ]; then
		# Nothing live. Stop a leftover color so it cannot win the lock with an old build.
		running "$(other "$target")" && dc stop -t "$STOP_TIMEOUT" "$(other "$target")"
		dc up -d --no-deps --force-recreate "$target"
		wait_for "$target" readyz "$READY_TIMEOUT" || die "$target did not become ready; see: docker compose logs $target"
		log "$target is live"
		return
	fi

	dc up -d --no-deps --force-recreate "$target"
	if ! wait_for "$target" healthz 60; then
		dc stop "$target" || true
		die "$target failed to start; $cur is still live. See: docker compose logs $target"
	fi
	log "$target is standing by; stopping $cur"

	dc stop -t "$STOP_TIMEOUT" "$cur"
	if wait_for "$target" readyz "$READY_TIMEOUT"; then
		log "$target is live. $cur is stopped and kept for ./deploy.sh rollback"
		return
	fi

	log "$target did not become ready; restoring $cur"
	dc stop -t "$STOP_TIMEOUT" "$target" || true
	dc start "$cur"
	wait_for "$cur" readyz "$READY_TIMEOUT" || die "$cur did not come back either; check: docker compose logs $cur $target"
	die "rolled back to $cur. See: docker compose logs $target"
}

cmd_rollback() {
	local cur prev
	cur=$(live)
	[ -n "$cur" ] || die "no color is live; use ./deploy.sh to start one"
	prev=$(other "$cur")
	exists "$prev" || die "no previous $prev container to roll back to"
	log "rolling back: $cur → $prev"
	log "note: if $cur migrated the database, the pre-start copies are in /data/backups"

	dc start "$prev"
	wait_for "$prev" healthz 60 || die "$prev failed to start; $cur is still live"
	dc stop -t "$STOP_TIMEOUT" "$cur"
	if wait_for "$prev" readyz "$READY_TIMEOUT"; then
		log "$prev is live"
		return
	fi
	log "$prev did not become ready; restoring $cur"
	dc stop "$prev" || true
	dc start "$cur"
	wait_for "$cur" readyz "$READY_TIMEOUT" || die "$cur did not come back; check the logs"
	die "rollback failed; $cur is live again"
}

case "${1:-deploy}" in
deploy) cmd_deploy ;;
rollback) cmd_rollback ;;
status) cmd_status ;;
*) die "usage: $0 [deploy|rollback|status]" ;;
esac
