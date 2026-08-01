#!/bin/sh
set -eu

: "${CFL_LIFECYCLE_MINT_HOST:?missing lifecycle mint host}"
: "${CFL_LIFECYCLE_MINT_PORT:?missing lifecycle mint port}"

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT INT TERM

socat "TCP-LISTEN:${CFL_LIFECYCLE_MINT_PORT},bind=127.0.0.1,fork,reuseaddr" \
  "TCP:${CFL_LIFECYCLE_MINT_HOST}:${CFL_LIFECYCLE_MINT_PORT}" &
socat 'TCP-LISTEN:14101,bind=0.0.0.0,fork,reuseaddr' 'TCP:127.0.0.1:4101' &
socat 'TCP-LISTEN:14102,bind=0.0.0.0,fork,reuseaddr' 'TCP:127.0.0.1:4102' &
socat 'TCP-LISTEN:14300,bind=0.0.0.0,fork,reuseaddr' 'TCP:127.0.0.1:4300' &

wait
