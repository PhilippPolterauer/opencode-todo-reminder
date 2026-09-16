-include ../../cicd-common.mk
-include /etc/cicd-common.mk

COMPOSE ?= docker compose

# Defaults, not requirements - a bare `make docker-up` or `make live-test-full`
# now works with zero manual export beforehand, PROVIDED auth.json exists at
# the standard location extract-opencode-auth-path.sh checks. Override either
# on the command line the normal way: OPENCODE_MODEL=other/model make docker-up.
# `?=` is recursively expanded, so this shells out on each reference rather
# than once - harmless here (a single fast file-existence check, no side
# effects, safe to call repeatedly), not worth `:=`'s loss of override
# ordering flexibility for it.
OPENCODE_MODEL ?= opencode/big-pickle
OPENCODE_AUTH_JSON_HOST_PATH ?= $(shell ./extract-opencode-auth-path.sh 2>/dev/null)
export OPENCODE_MODEL OPENCODE_AUTH_JSON_HOST_PATH

.PHONY: docker-build docker-up docker-down docker-logs live-test live-test-full auth-path

docker-build: ## Build the live-test opencode-server image from the current repo checkout
	$(COMPOSE) build

# The guards below still matter with defaults in place: they catch the case
# where auto-discovery genuinely found nothing (no auth.json on this host at
# the standard location) rather than merely "you forgot to export something."
docker-up: ## Start the live-test opencode-server (foreground)
	@test -n "$(OPENCODE_MODEL)" || (echo "OPENCODE_MODEL resolved empty - pass it directly: OPENCODE_MODEL=opencode/big-pickle make docker-up" >&2; exit 1)
	@test -n "$(OPENCODE_AUTH_JSON_HOST_PATH)" || (echo "No auth.json found by extract-opencode-auth-path.sh - pass the path directly: OPENCODE_AUTH_JSON_HOST_PATH=/real/path make docker-up" >&2; exit 1)
	$(COMPOSE) up --build

docker-down: ## Stop the live-test opencode-server
	$(COMPOSE) down

docker-logs: ## Tail the live-test opencode-server's logs
	$(COMPOSE) logs -f

auth-path: ## Print the real host auth.json path that would be used (same discovery docker-up's default runs)
	@./extract-opencode-auth-path.sh

live-test: ## Run the actual live test against an already-running server (see docker-up)
	python3 run_livetest.py

live-test-full: ## One command: build, start server detached, run the test, capture logs, tear down
	./run-live-test.sh
