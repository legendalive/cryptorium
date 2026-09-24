# Cryptorium // Quantitative Execution Terminal

Cryptorium is a static, high-reliability cryptocurrency futures trading terminal designed for Binance Futures (Testnet & Production). It combines client-side WebCrypto HMAC-SHA256 request signing, zero-bypass Pre-Trade Risk Gatekeeping (<1ms), Gemini AI Market Regime Supervision, and continuous automated lifecycle loops.

---

## GitHub Actions Automated Deployment

Cryptorium is configured for continuous deployment to **GitHub Pages** using official GitHub Actions (`.github/workflows/deploy.yml`).

### Step 1: Initialize Git and Push to GitHub

Run the following commands in your project root:

```bash
# Initialize local git repository
git init

# Stage all files
git add .

# Commit project baseline
git commit -m "feat(phase-7): automated deployment pipeline to GitHub Pages"

# Rename branch to main
git branch -M main

# Link your GitHub repository remote (replace with your repo URL)
git remote add origin https://github.com/<your-username>/<your-repo-name>.git

# Push to GitHub
git push -u origin main
```

---

### Step 2: Configure GitHub Pages Settings

1. Navigate to your repository on GitHub.
2. Click **Settings** > **Pages** (in the left sidebar).
3. Under **Build and deployment** > **Source**, select:
   **GitHub Actions** (do *not* select "Deploy from a branch").
4. Once selected, any push to `main` (or `master`) or manual trigger via `Actions` > `Deploy Cryptorium to GitHub Pages` > `Run workflow` will automatically build and publish your terminal.
5. Your live app URL will be available at:
   `https://<your-username>.github.io/<your-repo-name>/`

---

### Step 3: Zero-Leak API Key Security & Storage

Cryptorium operates as a **100% client-side application** with **fail-closed security**:

- **No Secrets in GitHub**: Never commit Binance API Keys, Secrets, or Gemini API keys to version control.
- **In-Browser Encryption & Storage**: API credentials entered in the terminal UI are saved strictly into browser `localStorage` on your client machine.
- **WebCrypto HMAC Signing**: All Binance Futures REST request payloads are signed locally in your browser memory using the native `window.crypto.subtle` API (`HMAC-SHA256`). Credentials never leave your device.
- **Environment Isolation**: The environment switcher allows toggling between Binance Futures Testnet (`https://testnet.binancefuture.com`) and Production (`https://fapi.binance.com`).

---

### Verification & Test Suite

Run the automated test suites locally:

```bash
# Phase 3: Pre-Trade Risk Engine tests (23/23 passing)
node services/riskEngine.test.mjs

# Phase 4: Gemini AI Market Regime Supervisor tests (7/7 passing)
node services/geminiSupervisor.test.mjs

# Phase 5: AutoLoop Controller & Emergency Controls tests (7/7 passing)
node services/autoLoopController.test.mjs
```
