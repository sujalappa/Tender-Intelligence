#!/usr/bin/env bash
# Build the React client and publish it to S3 + CloudFront. Run on YOUR
# computer (Git Bash), with the AWS CLI installed and `aws configure` done:
#   VITE_API_URL=https://<ip-with-dashes>.sslip.io \
#   S3_BUCKET=<bucket-name> CF_DISTRIBUTION_ID=<distribution-id> \
#   bash deploy/aws/deploy-client.sh
set -euo pipefail
: "${VITE_API_URL:?set VITE_API_URL to the API address, e.g. https://13-233-10-5.sslip.io}"
: "${S3_BUCKET:?set S3_BUCKET}"
: "${CF_DISTRIBUTION_ID:?set CF_DISTRIBUTION_ID}"
cd "$(dirname "$0")/../../client"

npm ci
VITE_API_URL="$VITE_API_URL" npm run build

# Hashed assets can be cached for a year; index.html must never be cached,
# or users keep loading an old build after a deploy.
aws s3 sync dist/assets "s3://$S3_BUCKET/assets" --delete --cache-control "public,max-age=31536000,immutable"
aws s3 sync dist "s3://$S3_BUCKET" --delete --exclude "assets/*" --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id "$CF_DISTRIBUTION_ID" --paths "/index.html" "/" >/dev/null
echo "==> Client published to https://$(aws cloudfront get-distribution --id "$CF_DISTRIBUTION_ID" --query 'Distribution.DomainName' --output text)"
