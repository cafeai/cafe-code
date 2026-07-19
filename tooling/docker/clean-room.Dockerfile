FROM node:24.13.1-bookworm@sha256:00e9195ebd49985a6da8921f419978d85dfe354589755192dc090425ce4da2f7 AS toolchain

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
RUN corepack yarn install --immutable --inline-builds

FROM toolchain AS quality
RUN corepack yarn audit:repository \
  && corepack yarn fmt:check \
  && corepack yarn lint \
  && corepack yarn typecheck \
  && corepack yarn test \
  && corepack yarn build:desktop \
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
