FROM node:22-bookworm

# The OSS Scanner builder exposes about 16 GiB RAM plus 3 GiB swap. The normal
# fast-build heap exceeds that host's safe capacity, so use the CI-sized cap.
ENV DEBIAN_FRONTEND=noninteractive \
    CI=1 \
    FRONTALIERE_BUILD_MAX_OLD_SPACE_SIZE=14336

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# The scanner has already checked out the exact commit used for this build.
# Copy that working tree directly so the build does not spend its timeout
# refetching the repository's very large Git history.
COPY . /src/

RUN npm ci --no-audit --no-fund
RUN npm run build:fast
