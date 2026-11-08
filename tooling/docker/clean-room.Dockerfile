FROM node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a AS toolchain

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV CI=1

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    build-essential \
    dbus \
    dbus-x11 \
    git \
    gnome-keyring \
    libasound2 \
    libgbm1 \
    libnspr4 \
    libnss3 \
    libsecret-1-dev \
    python3 \
    rpm \
    xauth \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare yarn@4.17.1 --activate \
  && test "$(corepack yarn --version)" = "4.17.1"

ARG ABSENT_EXECUTABLE=__unsupported_runtime__
RUN ! command -v "${ABSENT_EXECUTABLE}"

WORKDIR /workspace
COPY . .
# The immutable image and repository pin must move together. A digest update is
# not permission to build using Current Node or a different LTS patch.
RUN test "$(node --version)" = "v$(tr -d '\r\n' < .node-version)"
RUN corepack yarn install --immutable --inline-builds

FROM toolchain AS quality
RUN corepack yarn audit:repository \
  && corepack yarn fmt:check \
  && corepack yarn lint \
  && corepack yarn typecheck \
  && corepack yarn test \
  && corepack yarn build:desktop --force \
  && corepack yarn release:smoke

FROM quality AS browser
RUN corepack yarn workspace @cafecode/web exec playwright install --with-deps chromium
RUN corepack yarn workspace @cafecode/web test:browser

FROM quality AS linux-artifact
RUN corepack yarn dist:desktop:linux
RUN bash tooling/docker/prepare-linux-artifact-smoke.sh
ENV CAFE_CODE_LINUX_EXTRACTED_ROOT=/tmp/cafecode-appimage-smoke/squashfs-root
ENV CAFE_CODE_NATIVE_SMOKE_DISABLE_CHROMIUM_SANDBOX=1
ENV XDG_CURRENT_DESKTOP=GNOME
RUN bash tooling/docker/run-linux-artifact-smoke.sh
