#!/bin/sh
# Resume-safe driver for the whole corridor dataset.
#
# Runs each job to completion, re-invoking it whenever the public Overpass
# mirrors answer 504/429. Every job is per-batch/per-country cached, so a
# throttled pass never discards work that already landed.
#
# Each pass is bounded (~150s) because the sandbox kills long commands; the
# loop simply starts a fresh pass after that, and the inner jobs skip anything
# already cached.
#
#   fetch-corridors : route relations terminating at Iran -> raw-corr-*.json (23 batches)
#   fetch-reach     : corridor relations per country      -> raw-reach-<ISO>.json
#   fetch-roads-all : motorway/trunk network per country  -> raw-roads-<ISO>.json
cd "$(dirname "$0")" || exit 1

COUNTRIES="IR TR IQ SY AM AZ GE TM UZ AF PK OM SA KW"

want_corr=$(ls raw-corr-*.json 2>/dev/null | wc -l)
echo "corridor batches cached: $want_corr / 23"

# --- corridors -------------------------------------------------------------
i=0
while [ "$i" -lt 60 ]; do
  i=$((i + 1))
  have=$(ls raw-corr-*.json 2>/dev/null | wc -l)
  [ "$have" -ge 23 ] && break
  echo "=== corridors pass $i: $have/23 ==="
  timeout 150 node fetch.mjs corridors
  sleep 10
done
echo "corridor batches: $(ls raw-corr-*.json 2>/dev/null | wc -l)/23"

# --- reach -----------------------------------------------------------------
i=0
while [ "$i" -lt 60 ]; do
  i=$((i + 1))
  have=$(ls raw-reach-*.json 2>/dev/null | wc -l)
  [ "$have" -ge 14 ] && break
  echo "=== reach pass $i: $have/14 ==="
  timeout 150 node fetch.mjs reach
  sleep 10
done
echo "reach countries: $(ls raw-reach-*.json 2>/dev/null | wc -l)/14"

# --- internal roads --------------------------------------------------------
i=0
while [ "$i" -lt 80 ]; do
  i=$((i + 1))
  have=$(ls raw-roads-*.json 2>/dev/null | wc -l)
  [ "$have" -ge 13 ] && break
  echo "=== roads pass $i: $have/13 ==="
  timeout 150 node fetch.mjs roads-all
  sleep 10
done
echo "road countries: $(ls raw-roads-*.json 2>/dev/null | wc -l)/13"

echo "=== inventory ==="
ls raw-corr-*.json 2>/dev/null | wc -l | xargs echo "corridor batches:"
ls raw-reach-*.json 2>/dev/null | wc -l | xargs echo "reach countries:"
ls raw-roads-*.json 2>/dev/null | wc -l | xargs echo "road countries:"