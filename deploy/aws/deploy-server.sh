#!/usr/bin/env bash
# Update the API on the Lightsail server to the latest main. Run ON THE SERVER:
#   bash ~/Tender-Intelligence/deploy/aws/deploy-server.sh
# Refuses to restart while a tender is being analysed — a restart kills the
# billed in-flight model call. Pass --force to restart anyway.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ "${1:-}" != "--force" ]; then
  RUNNING=$(cd server && node --input-type=module -e '
    import "dotenv/config"; import mongoose from "mongoose";
    await mongoose.connect(process.env.MONGODB_URI);
    const n = await mongoose.connection.db.collection("tenders").countDocuments({ status: { $in: ["parsing", "segregating"] } });
    console.log(n); process.exit(0);')
  if [ "$RUNNING" != "0" ]; then
    echo "!! $RUNNING tender(s) are being analysed right now. Restarting would kill them."
    echo "   Wait for them to finish, or re-run with --force."
    exit 1
  fi
fi

git pull --ff-only
(cd server && npm ci --omit=dev)
pm2 restart tender-api
echo "==> API restarted on $(git log --oneline -1)"
