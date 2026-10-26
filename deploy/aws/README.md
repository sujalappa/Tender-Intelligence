# Deploying on AWS

- **API:** one Lightsail server (Node 24 + PM2 + Caddy). Uploads are kept on its own disk.
- **Client:** S3 + CloudFront.
- **Database:** stays on MongoDB Atlas.

No domain is needed. The API gets HTTPS at `https://<ip-with-dashes>.sslip.io`, and the client is served at `https://<id>.cloudfront.net`.

The API is deliberately not routed through CloudFront. CloudFront drops a request after 60 seconds, and chat over the full tender, Interpret and summary generation can take longer.

## 1. Check your free credits

AWS console → **Billing and Cost Management** → **Credits**, and the **Free Tier** page. Any credits shown there cover Lightsail and CloudFront usage.

## 2. Create the API server (Lightsail)

1. Lightsail console → **Create instance**.
   - **Region:** Mumbai (ap-south-1).
   - **Platform:** Linux/Unix.
   - **Blueprint:** OS Only → **Ubuntu 24.04 LTS**.
   - **Plan:** 2 GB RAM.
2. **Networking** tab → **Create static IP** and attach it to the instance. Note the IP address.
3. **Networking** → IPv4 firewall → add rules for **HTTPS (443)** and **HTTP (80)**. SSH (22) is already open.
4. Click **Connect using SSH** (opens a browser terminal) and run:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/sujalappa/Tender-Intelligence/main/deploy/aws/setup-server.sh -o setup.sh
   bash setup.sh <STATIC_IP>
   ```
5. Create `~/Tender-Intelligence/server/.env`:
   - Run `nano ~/Tender-Intelligence/server/.env`.
   - Paste the contents of your local `server/.env`. Never commit this file to git.
   - Then set or add these lines:
     ```
     UPLOAD_DIR=/var/data/uploads
     COOKIE_SECURE=true
     COOKIE_CROSS_SITE=true
     ALLOWED_ORIGINS=https://<your-distribution>.cloudfront.net
     OPENROUTER_SITE_URL=https://<your-distribution>.cloudfront.net
     ```
   - You'll know the CloudFront address after step 3. Fill these in then, and run `pm2 restart tender-api`.
6. Start the API:
   ```bash
   cd ~/Tender-Intelligence && pm2 start deploy/aws/ecosystem.config.cjs && pm2 save
   pm2 startup systemd -u ubuntu --hp /home/ubuntu   # then run the sudo command it prints
   ```
7. Check it: open `https://<ip-with-dashes>.sslip.io/api/health`. It should return `{"ok":true,...}`.

## 3. Create the client (S3 + CloudFront)

1. **S3** → Create bucket.
   - **Name:** for example `bhushilp-tender-client`.
   - **Region:** Mumbai.
   - Keep **Block all public access** turned on.
2. **CloudFront** → Create distribution.
   - **Origin:** the bucket. Choose **Origin access control (recommended)** and let CloudFront update the bucket policy.
   - **Viewer protocol policy:** Redirect HTTP to HTTPS.
   - **Default root object:** `index.html`.
   - **Web Application Firewall:** do not enable security protections. It's a paid add-on.
3. **CloudFront** → **Functions** → Create function.
   - **Name:** `spa-rewrite`.
   - Paste in `deploy/aws/spa-rewrite.js`, then click **Publish**.
   - Associate it with the distribution's default behaviour as a **Viewer request** function.

   Without this, refreshing a page such as `/tenders/123` returns a 404.
4. Note the distribution **ID** and its **domain** (`dxxxx.cloudfront.net`). Put the domain into the server's `.env` (step 2.5).

## 4. Publish the client (from your computer)

1. Install the AWS CLI and run `aws configure` with an access key for an IAM user that has S3 + CloudFront permissions.
2. Run:
   ```bash
   VITE_API_URL=https://<ip-with-dashes>.sslip.io S3_BUCKET=bhushilp-tender-client CF_DISTRIBUTION_ID=<ID> bash deploy/aws/deploy-client.sh
   ```

## Updating later

- **API:** on the server, run `bash ~/Tender-Intelligence/deploy/aws/deploy-server.sh`. It refuses to restart while a tender is being analysed; add `--force` to restart anyway.
- **Client:** re-run step 4.
- **Pushing to GitHub:** no longer redeploys anything by itself, so a push never kills a running tender.

## Moving off Render and Vercel

- Keep both running until the AWS setup works end to end.
- To carry existing tenders' original files across, re-upload them with **Upload a copy** on each tender. Extracted data is in Atlas and needs no copying.
- When AWS works, delete the Render service and the Vercel project.
