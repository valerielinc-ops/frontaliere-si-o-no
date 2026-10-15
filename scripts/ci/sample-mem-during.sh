#!/usr/bin/env bash
# Campiona MemAvailable dell'host mentre un comando gira, e si ferma
# nell'istante in cui quel comando termina — mai un timer proprio
# indipendente dal lavoro che accompagna.
#
# Il tentativo precedente (rimosso in PR #6559, vedi follow-up #6573) era uno
# step `background:` a sé con un ciclo `sleep 5` ripetuto 350 volte (~29 min):
# a suite ROSSA il job restava comunque appeso al `wait-all` finale ad
# aspettare che quel timer finisse di dormire, trasformando un fallimento
# rapido in mezz'ora di runner. Qui il sampler gira in un subshell separato
# accanto al comando osservato (`"$@"`), e la sua vita finisce nell'istante in
# cui `wait "$cmd_pid"` — il primitivo che REAP davvero un figlio, non un
# polling — sblocca: appena il comando esce, successo o fallimento, il
# sampler riceve TERM. Un `kill -0` periodico sarebbe stato il bug gemello di
# quello che questo script rimpiazza: su un processo già uscito ma non ancora
# reaped (zombie) continua a rispondere successo finché qualcuno lo reap, cioè
# esattamente il ciclo che non si accorge mai della fine del lavoro.
#
# ── Perché l'attesa NON è uno `sleep` ────────────────────────────────────────
# `kill` sul subshell del sampler NON uccide lo `sleep` che ha in corso: quello
# è un processo figlio a sé, resta orfano e continua a tenere aperto l'fd di
# stdout che ha ereditato. Un consumatore che legge lo stdout dello step fino a
# EOF (il log-capture del runner, o un semplice `spawnSync`) aspetta quindi
# l'orfano, non il comando osservato — misurato su questo script: comando da
# 0,2 s con `INTERVAL_S=5` tornava in 5,0 s. È lo STESSO antipattern che questo
# file esiste per rimuovere, solo accorciato all'intervallo. Per questo
# l'attesa è `read -t` — un BUILTIN di bash, nessun processo figlio da
# uccidere — su un fd tenuto aperto da una fifo che nessuno scrive mai, e il
# subshell ha stdout su /dev/null così nemmeno un `awk` in volo può trattenere
# la pipe dello step.
#
# Uso: scripts/ci/sample-mem-during.sh -- <comando...>
# Exit code = quello del comando osservato, mai del sampler.
set -uo pipefail

MEMINFO="${SAMPLE_MEM_DURING_MEMINFO:-/proc/meminfo}"
INTERVAL_S="${SAMPLE_MEM_DURING_INTERVAL_S:-5}"
LOG_PREFIX="[mem-sample]"

if [ "${1:-}" = "--" ]; then
  shift
fi

if [ "$#" -eq 0 ]; then
  echo "${LOG_PREFIX} uso: sample-mem-during.sh -- <comando...>" >&2
  exit 2
fi

# Intervallo non numerico = `read -t` fallisce all'ISTANTE dentro `while true`,
# cioè il sampler brucia una CPU intera appendendo campioni finché il comando
# osservato non finisce — perturbando proprio la misura per cui esiste. Loud e
# subito, prima ancora di lanciare il comando.
case "$INTERVAL_S" in
  '' | . | *[!0-9.]* | *.*.*)
    echo "${LOG_PREFIX} intervallo non valido: SAMPLE_MEM_DURING_INTERVAL_S='${INTERVAL_S}' (atteso un numero di secondi)" >&2
    exit 2
    ;;
esac

samples_file=$(mktemp)
tick_dir=$(mktemp -d)
mkfifo "${tick_dir}/tick"
# Aperta in lettura-SCRITTURA: c'è sempre uno scrittore (noi), quindi la fifo
# non va mai in EOF e `read -t` blocca per l'intervallo intero invece di
# tornare subito. Nessuno ci scrive mai dentro: serve solo come sorgente che
# non diventa mai pronta.
exec 9<>"${tick_dir}/tick"
cleanup_tmp() { rm -f "$samples_file"; rm -rf "$tick_dir"; }
trap cleanup_tmp EXIT

"$@" &
cmd_pid=$!

sampler_pid=""
if [ -r "$MEMINFO" ]; then
  (
    while true; do
      awk '/^MemAvailable:/ { print int($2 / 1024); exit }' "$MEMINFO" 2>/dev/null >>"$samples_file"
      # Builtin, non `sleep`: niente processo figlio che sopravviva al kill del
      # subshell tenendosi lo stdout ereditato (vedi la testata).
      read -r -t "$INTERVAL_S" -u 9 _ || true
    done
  ) >/dev/null 2>&1 &
  sampler_pid=$!
else
  echo "${LOG_PREFIX} MemAvailable non leggibile (${MEMINFO}): sampler spento (host non Linux)" >&2
fi

# Forward di TERM/INT sia al comando osservato sia al sampler: su
# cancellazione del job non deve restare un processo orfano dietro nessuno
# dei due.
trap 'kill "$cmd_pid" "$sampler_pid" 2>/dev/null || true' TERM INT

wait "$cmd_pid"
cmd_status=$?

if [ -n "$sampler_pid" ]; then
  kill "$sampler_pid" 2>/dev/null || true
  wait "$sampler_pid" 2>/dev/null || true
fi

samples=0
min_mb=""
max_mb=""
if [ -s "$samples_file" ]; then
  while IFS= read -r mb; do
    [ -n "$mb" ] || continue
    samples=$((samples + 1))
    if [ -z "$min_mb" ] || [ "$mb" -lt "$min_mb" ]; then min_mb="$mb"; fi
    if [ -z "$max_mb" ] || [ "$mb" -gt "$max_mb" ]; then max_mb="$mb"; fi
  done <"$samples_file"
fi

if [ -n "$min_mb" ]; then
  echo "${LOG_PREFIX} MemAvailable min=${min_mb}MB max=${max_mb}MB samples=${samples} intervalS=${INTERVAL_S}"
else
  echo "${LOG_PREFIX} nessun campione raccolto"
fi

exit "$cmd_status"
