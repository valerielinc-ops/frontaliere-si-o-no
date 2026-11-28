#!/usr/bin/env bash
# host-heartbeat.sh — lo stato dell'host di una gamba di deploy, scritto FUORI
# dal runner mentre il job gira.
#
# Perche': un runner che «lost communication with the server» non lascia il log
# del job (`actions/jobs/<id>/logs` → BlobNotFound; misurato il 2026-11-28 sui
# job 140785929618, 140922711922 e 140943398731). Il campionatore `[hostmem]`
# dello step Build stampa solo li' dentro, quindi sparisce proprio nel caso che
# deve spiegare, e lo step «Build IT Rollup bundle» non ne ha nessuno.
#
# Canale: un commit status `deploy-host/<locale>` sullo SHA della run, stato
# sempre `success` (e' una misura, non un check). Ogni POST resta come voce a
# se', quindi la serie si rilegge anche a runner perso:
#
#   gh api -X GET repos/<o>/<r>/commits/<sha>/statuses --paginate \
#     --jq '.[]|select(.context|startswith("deploy-host/"))|[.created_at,.context,.description,.target_url]|@tsv'
#
# Gli status creati con GITHUB_TOKEN non avviano i workflow `on: status`.
#
# Campi (MB salvo dove detto):
#   t     secondi dall'avvio del battito
#   av    MemAvailable ora / minima dall'ultimo invio
#   swf   SwapFree
#   si so pagine rientrate / uscite dallo swap dall'ultimo invio, in MB
#   pm    PSI memory full avg60 (% del tempo con TUTTI i task fermi)
#   pio   PSI io full avg60
#   pc    PSI cpu some avg60
#   ld    load a 1 minuto
#   d     GB liberi su / e su /mnt (dove vive lo swapfile)
#   rss   somma degli RSS / processo piu' grande (nome)
#   at    ultimo plugin chiuso secondo i log del build
#
# Lettura: av, swf in calo con si/so e pm alti = memoria o thrash; d → 0 = disco;
# ld e pc alti a memoria sana = CPU; ultimo campione sano e poi silenzio = rete o
# guasto dell'host (oppure un picco piu' breve dell'intervallo: non distinguibili).
#
# Fail-open ovunque: nessun errore qui puo' toccare il job. Nessun output nel
# dist, nessuna variabile d'ambiente aggiunta agli step di build: il token vive
# solo in questo processo.

set -u

PROC_ROOT="${HEARTBEAT_PROC_ROOT:-/proc}"
TICK_S="${HEARTBEAT_TICK_S:-15}"
# 120 s a regime: quattro gambe fanno 120 richieste l'ora. 30 s sotto pressione.
NORMAL_S="${HEARTBEAT_NORMAL_S:-120}"
PRESSURE_S="${HEARTBEAT_PRESSURE_S:-30}"
# GitHub accetta al piu' 1000 status per SHA e contesto.
MAX_POSTS="${HEARTBEAT_MAX_POSTS:-300}"
# Sotto questa quota residua il battito rallenta: la quota serve al deploy.
QUOTA_FLOOR="${HEARTBEAT_QUOTA_FLOOR:-500}"
SLOW_S=600
# Il job ha timeout-minutes 360: oltre non c'e' nulla da osservare.
LIFETIME_S="${HEARTBEAT_LIFETIME_S:-21600}"
LOCALE_ID="${HEARTBEAT_LOCALE:-unknown}"
HEADERS_FILE="${HEARTBEAT_HEADERS_FILE:-${RUNNER_TEMP:-/tmp}/host-heartbeat.headers}"
BUILD_LOGS="${HEARTBEAT_BUILD_LOGS:-/tmp/build.log /tmp/build-bundle.log}"

meminfo_mb() {
  awk -v key="$1:" '$1 == key { printf "%d", $2 / 1024; f = 1 } END { if (!f) printf "-1" }' \
    "$PROC_ROOT/meminfo" 2>/dev/null || printf -- '-1'
}

# psi <memory|io|cpu> <some|full> <avg10|avg60>
psi() {
  awk -v kind="$2" -v field="$3=" '$1 == kind { for (i = 2; i <= NF; i++) if (index($i, field) == 1) { printf "%d", substr($i, length(field) + 1); f = 1 } } END { if (!f) printf "-1" }' \
    "$PROC_ROOT/pressure/$1" 2>/dev/null || printf -- '-1'
}

swap_pages() {
  awk -v key="$1" '$1 == key { printf "%d", $2; f = 1 } END { if (!f) printf "0" }' "$PROC_ROOT/vmstat" 2>/dev/null || printf '0'
}

disk_free_gb() {
  df -Pk "$1" 2>/dev/null | awk 'NR == 2 { printf "%d", $4 / 1048576; f = 1 } END { if (!f) printf "-1" }'
}

rss_summary() {
  ps -eo rss=,comm= 2>/dev/null | awk '{ total += $1; if ($1 > max) { max = $1; name = $2 } } END { printf "%d/%d(%s)", total / 1024, max / 1024, substr(name, 1, 12) }'
}

# Il log piu' recente fra quelli del build; solo la coda, per non rileggere decine di MB.
last_plugin() {
  local newest='' f
  for f in $BUILD_LOGS; do
    [ -f "$f" ] || continue
    if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest="$f"; fi
  done
  [ -n "$newest" ] || return 0
  tail -c 200000 "$newest" 2>/dev/null | awk '$1 == "[profile-mem]" { p = $2 } END { printf "%s", substr(p, 1, 28) }'
}

started_at=$(date +%s)
prev_in=$(swap_pages pswpin)
prev_out=$(swap_pages pswpout)
min_avail=-1

# Aggiorna il minimo di MemAvailable e dice se l'host e' sotto pressione.
tick() {
  cur_avail=$(meminfo_mb MemAvailable)
  if [ "$min_avail" -lt 0 ] || { [ "$cur_avail" -ge 0 ] && [ "$cur_avail" -lt "$min_avail" ]; }; then
    min_avail=$cur_avail
  fi
  local stall disk
  stall=$(psi memory full avg10)
  disk=$(disk_free_gb /)
  if { [ "$cur_avail" -ge 0 ] && [ "$cur_avail" -lt 1500 ]; } || [ "$stall" -ge 10 ] || { [ "$disk" -ge 0 ] && [ "$disk" -lt 10 ]; }; then
    under_pressure=1
  else
    under_pressure=0
  fi
}

compose() {
  local now_in now_out si so load line
  now_in=$(swap_pages pswpin)
  now_out=$(swap_pages pswpout)
  # pagine da 4 KiB → MB
  si=$(( (now_in - prev_in) / 256 ))
  so=$(( (now_out - prev_out) / 256 ))
  prev_in=$now_in
  prev_out=$now_out
  load=$(awk '{ printf "%s", $1 }' "$PROC_ROOT/loadavg" 2>/dev/null || true)
  line="t=$(( $(date +%s) - started_at )) av=${cur_avail}/${min_avail} swf=$(meminfo_mb SwapFree) si=${si} so=${so}"
  line="$line pm=$(psi memory full avg60) pio=$(psi io full avg60) pc=$(psi cpu some avg60) ld=${load:--1}"
  line="$line d=$(disk_free_gb /)/$(disk_free_gb /mnt) rss=$(rss_summary) at=$(last_plugin)"
  # `description` di un commit status: 140 caratteri. `"` e `\` romperebbero il JSON.
  description=$(printf '%s' "$line" | tr -d '"\\\n' | cut -c1-140)
  min_avail=-1
}

# Ritorna 0 se GitHub ha accettato lo status.
publish() {
  [ -n "${HEARTBEAT_TOKEN:-}" ] || return 1
  local url body code
  url="${GITHUB_API_URL:-https://api.github.com}/repos/${GITHUB_REPOSITORY:-}/statuses/${GITHUB_SHA:-}"
  body=$(printf '{"state":"success","context":"deploy-host/%s","description":"%s","target_url":"%s/%s/actions/runs/%s/attempts/%s"}' \
    "$LOCALE_ID" "$description" "${GITHUB_SERVER_URL:-https://github.com}" "${GITHUB_REPOSITORY:-}" "${GITHUB_RUN_ID:-}" "${GITHUB_RUN_ATTEMPT:-1}")
  : > "$HEADERS_FILE" 2>/dev/null || true
  # Il token passa da stdin (-K -), mai in argv: `ps` e' leggibile dagli altri processi.
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$HEARTBEAT_TOKEN" |
    curl -K - --silent --max-time 10 --output /dev/null --dump-header "$HEADERS_FILE" --write-out '%{http_code}' \
      -X POST -H 'Accept: application/vnd.github+json' --data "$body" "$url" 2>/dev/null) || code=000
  last_code=$code
  [ "$code" = 201 ]
}

quota_remaining() {
  awk 'tolower($1) == "x-ratelimit-remaining:" { gsub(/\r/, "", $2); v = $2 } END { printf "%s", v }' "$HEADERS_FILE" 2>/dev/null || true
}

if [ "${1:-}" = "--once" ]; then
  # Un campione sincrono: nel log dello step si vede se il canale funziona.
  tick
  compose
  echo "[host-heartbeat] $description"
  if publish; then
    echo "[host-heartbeat] status deploy-host/${LOCALE_ID} pubblicato"
  else
    echo "::warning::[host-heartbeat] status non pubblicato (HTTP ${last_code:-nessun token}): se questa gamba perde il runner non restera' alcun campione"
  fi
  exit 0
fi

posts=0
failures=0
last_post=0
was_pressure=0
while [ "$posts" -lt "$MAX_POSTS" ] && [ $(( $(date +%s) - started_at )) -lt "$LIFETIME_S" ]; do
  tick
  interval=$NORMAL_S
  [ "$under_pressure" = 1 ] && interval=$PRESSURE_S
  remaining=$(quota_remaining)
  case "$remaining" in
    ''|*[!0-9]*) ;;
    *) [ "$remaining" -lt "$QUOTA_FLOOR" ] && interval=$SLOW_S ;;
  esac
  # Errori ripetuti (403/429/rete): attesa crescente, fino a SLOW_S.
  if [ "$failures" -gt 0 ]; then
    backoff=$(( NORMAL_S * failures ))
    [ "$backoff" -gt "$SLOW_S" ] && backoff=$SLOW_S
    [ "$backoff" -gt "$interval" ] && interval=$backoff
  fi
  now=$(date +%s)
  # L'ingresso in pressione esce subito: e' il campione che puo' non avere un seguito.
  if [ $(( now - last_post )) -ge "$interval" ] ||
    { [ "$under_pressure" = 1 ] && [ "$was_pressure" = 0 ] && [ "$failures" = 0 ] && [ $(( now - last_post )) -ge "$PRESSURE_S" ]; }; then
    compose
    if publish; then failures=0; else failures=$(( failures + 1 )); fi
    echo "$(date -u +%FT%TZ) http=${last_code:-000} $description"
    posts=$(( posts + 1 ))
    last_post=$now
    was_pressure=$under_pressure
  fi
  sleep "$TICK_S"
done
exit 0
