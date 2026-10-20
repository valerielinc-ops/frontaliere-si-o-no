FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    CI=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# The scanner's checkout contains about 71 GiB of Git objects. Keep only its
# HEAD and refs in the build context, then fetch that exact commit shallowly.
COPY .git/ /tmp/oss-scanner-git/
RUN set -eu; \
    head="$(cat /tmp/oss-scanner-git/HEAD)"; \
    case "$head" in \
      "ref: "*) \
        ref="${head#ref: }"; \
        if [ -f "/tmp/oss-scanner-git/$ref" ]; then \
          commit="$(cat "/tmp/oss-scanner-git/$ref")"; \
        else \
          commit="$(awk -v ref="$ref" '$2 == ref { print $1; exit }' /tmp/oss-scanner-git/packed-refs 2>/dev/null || true)"; \
        fi \
        ;; \
      *) commit="$head" ;; \
    esac; \
    case "$commit" in \
      ''|*[!0-9a-f]*) echo 'Could not resolve the scanner checkout commit' >&2; exit 1 ;; \
    esac; \
    [ "${#commit}" -eq 40 ] || [ "${#commit}" -eq 64 ]; \
    git init --quiet /src; \
    git -C /src remote add origin https://github.com/valerielinc-ops/frontaliere-si-o-no.git; \
    git -C /src fetch --quiet --no-tags --depth=1 origin "$commit"; \
    git -C /src checkout --quiet --detach FETCH_HEAD; \
    test "$(git -C /src rev-parse HEAD)" = "$commit"; \
    rm -rf /tmp/oss-scanner-git

RUN npm ci --no-audit --no-fund
RUN npm run build:fast
