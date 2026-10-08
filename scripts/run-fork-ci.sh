#!/usr/bin/env bash
set -euo pipefail

export SURFPOOL_RPC_URL="${SURFPOOL_RPC_URL:-http://127.0.0.1:8899}"
export MAINNET_RPC_URL="${MAINNET_RPC_URL:-https://api.mainnet-beta.solana.com}"

mkdir -p .anchor target/deploy ~/.config/solana

if [[ ! -f ~/.config/solana/id.json ]]; then
  solana-keygen new --no-bip39-passphrase --silent -o ~/.config/solana/id.json
fi

if [[ ! -f target/deploy/pactum_vault-keypair.json ]]; then
  solana-keygen new --no-bip39-passphrase --silent -o target/deploy/pactum_vault-keypair.json
fi

# Anchor 1.x checks source/program-id consistency. Sync the checked-in
# placeholder to the ephemeral CI deployment key before building.
anchor keys sync

for attempt in 1 2 3; do
  if anchor build -- --features test-hooks; then
    break
  fi
  if [[ "$attempt" -eq 3 ]]; then
    echo "anchor build failed after ${attempt} attempts" >&2
    exit 1
  fi
  echo "anchor build attempt ${attempt} failed; retrying platform-tools/build setup..." >&2
  sleep 5
done

echo "Starting Surfpool mainnet fork..."
NO_DNA=1 surfpool start   --ci   --daemon   --rpc-url "$MAINNET_RPC_URL"

for _ in $(seq 1 60); do
  if curl -sf "$SURFPOOL_RPC_URL"     -H 'Content-Type: application/json'     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'     | grep -q '"ok"'; then
    break
  fi
  sleep 1
done

solana config set --url "$SURFPOOL_RPC_URL" >/dev/null
solana airdrop 10 >/dev/null

PROGRAM_ID="$(solana-keygen pubkey target/deploy/pactum_vault-keypair.json)"
export PACTUM_PROGRAM_ID="$PROGRAM_ID"

# Surfpool may answer getHealth before its local slot-leader stream is ready.
# Retry the actual deployment, without weakening the subsequent fork assertions.
deployed=0
for attempt in 1 2 3 4 5; do
  if solana program deploy \
      --url "$SURFPOOL_RPC_URL" \
      --program-id target/deploy/pactum_vault-keypair.json \
      target/deploy/pactum_vault.so; then
    deployed=1
    break
  fi
  echo "Local program deployment attempt ${attempt}/5 failed; checking Surfpool readiness before retry..." >&2
  curl -sf "$SURFPOOL_RPC_URL" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' || true
  sleep 4
done
if [[ "$deployed" -ne 1 ]]; then
  echo "Unable to deploy Pactum test program after 5 attempts" >&2
  exit 1
fi

npm run test:fork
