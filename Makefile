ifeq ($(wildcard /etc/cicd-common.mk),)
-include cicd-common.mk
else
include /etc/cicd-common.mk
endif

NPM ?= npm

.PHONY: lint test build verify e2e all clean \
        docker-build docker-up docker-down docker-logs live-test

node_modules: package.json package-lock.json
	$(NPM) ci
	@touch node_modules

lint: node_modules ## Typecheck (this project has no separate lint script)
	npx tsc --noEmit

build: node_modules ## Compile dist/ from src/
	$(NPM) run build

test: node_modules ## Unit test suite (vitest)
	$(NPM) test

verify: build ## Smoke-check the built artifact actually exists and exports the plugin
	@test -f dist/index.js || (echo "verify: dist/index.js missing after build" >&2; exit 1)
	@grep -q "TodoReminderPlugin" dist/index.js || (echo "verify: dist/index.js does not reference TodoReminderPlugin" >&2; exit 1)
	@echo "verify: OK - dist/index.js exists and references TodoReminderPlugin"

e2e: verify ## Real multi-step live test against a real opencode server + model (see test/live/README.md)
	$(MAKE) -C test/live live-test-full

all: lint build test verify ## Full pipeline EXCEPT e2e (e2e needs real credentials + a model choice, not run unattended)

clean: ## Remove build artifacts (keeps node_modules)
	rm -rf dist

docker-build: ## Build the live-test opencode-server image
	$(MAKE) -C test/live docker-build

docker-up: ## Start the live-test opencode-server (needs OPENCODE_MODEL + a real auth.json)
	$(MAKE) -C test/live docker-up

docker-down: ## Stop the live-test opencode-server
	$(MAKE) -C test/live docker-down

docker-logs: ## Tail the live-test opencode-server's logs
	$(MAKE) -C test/live docker-logs
