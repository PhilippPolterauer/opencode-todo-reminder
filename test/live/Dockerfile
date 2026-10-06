# syntax=docker/dockerfile:1
#
# Live-test opencode-serve image for the opencode-todo-reminder plugin.
# Build context is the REPO ROOT (see docker-compose.yml's `context: ../..`)
# - this builds from whatever's actually checked out locally, not a GitHub
# clone, so it always reflects the real working tree including anything
# not yet pushed. Mirrors opencode-model-eval's `server` stage (same base
# image, same privilege-drop entrypoint) - see that repo's Dockerfile for
# the full rationale on each choice. Permission profile grants edit+bash
# (their eval config denies both; this test needs the model to actually
# write files and run commands for a real multi-step build).
#
# Verified 2026-07-14 (opencode-model-eval's own Dockerfile) against
# opencode.ai/docs: ghcr.io/anomalyco/opencode is the current registry.
ARG OPENCODE_IMAGE=ghcr.io/anomalyco/opencode
ARG OPENCODE_REF=latest

FROM ${OPENCODE_IMAGE}:${OPENCODE_REF} AS base

USER root

RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache ca-certificates python3 setpriv nodejs npm; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 util-linux nodejs npm \
      && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "FATAL: no supported package manager (apk/apt-get) found in base image" >&2; \
      exit 1; \
    fi

ENV HOME=/home/harness
ARG WORKER_UID=1000
ARG WORKER_GID=1000

RUN if getent passwd "${WORKER_UID}" >/dev/null 2>&1; then \
      echo "uid ${WORKER_UID} already present, skipping user creation"; \
    else \
      if ! getent group "${WORKER_GID}" >/dev/null 2>&1; then \
        if command -v addgroup >/dev/null 2>&1 && ! command -v groupadd >/dev/null 2>&1; then \
          addgroup -g "${WORKER_GID}" harness; \
        else \
          groupadd --gid "${WORKER_GID}" harness; \
        fi; \
      fi; \
      if command -v adduser >/dev/null 2>&1 && ! command -v useradd >/dev/null 2>&1; then \
        adduser -u "${WORKER_UID}" -G "$(getent group "${WORKER_GID}" | cut -d: -f1)" \
          -h "${HOME}" -s /bin/sh -D harness; \
      else \
        useradd --uid "${WORKER_UID}" --gid "${WORKER_GID}" --home-dir "${HOME}" \
          --shell /bin/sh --no-create-home harness; \
      fi; \
    fi

RUN mkdir -p "${HOME}/.local/share/opencode" "${HOME}/.config/opencode" /workspace \
    && chown -R "${WORKER_UID}:${WORKER_GID}" "${HOME}" /workspace

# Copied from the actual local checkout (build context = repo root) -
# excludes node_modules/dist/.git/test via .dockerignore, rebuilt fresh
# here so the image is self-contained and doesn't depend on the host's
# own node_modules layout.
COPY --chown=1000:1000 package.json package-lock.json tsconfig.json tsconfig.build.json index.ts /opt/plugin-src/
COPY --chown=1000:1000 src /opt/plugin-src/src
RUN cd /opt/plugin-src && npm install --no-audit --no-fund && npm run build

COPY test/live/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY test/live/config/opencode.json /opt/harness/opencode.json
COPY --chown=1000:1000 test/live/config/todo-reminder.json "${HOME}/.config/opencode/todo-reminder.json"
RUN chmod 0755 /usr/local/bin/entrypoint.sh \
    && chmod 0644 /opt/harness/opencode.json

ENV OPENCODE_CONFIG=/opt/harness/opencode.json
WORKDIR /workspace

# Deliberately NOT 4096 - avoids colliding with opencode-model-eval's own
# ports (49604/49605/49606/8888) or Axiom's own live serve instance.
EXPOSE 49610
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["serve"]
