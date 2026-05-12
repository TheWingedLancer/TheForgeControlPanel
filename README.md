# TheForgeControlPanel

A private Azure Static Web App for starting, stopping, and idling FoundryVTT
games hosted on [The Forge](https://forge-vtt.com), gated behind Entra ID
authentication.

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │  Browser (you + guests)              │
                    │  https://<your-swa>.azurestaticapps  │
                    └────────────────┬─────────────────────┘
                                     │  signs in via AAD
                                     ▼
                    ┌─────────────────────────────────────┐
                    │  Azure Static Web App                │
                    │  ─ Hosts the React frontend          │
                    │  ─ Enforces AAD auth on all routes   │
                    │  ─ Injects x-ms-client-principal     │
                    └────────────────┬─────────────────────┘
                                     │  /api/* proxied to
                                     ▼
                    ┌─────────────────────────────────────┐
                    │  Azure Function App                  │
                    │  ─ Validates principal + allowlist   │
                    │  ─ Reads FORGE_API_KEY at runtime    │
                    │  ─ Calls forge-vtt.com/api/game/*    │
                    └────────────────┬─────────────────────┘
                                     │  managed-identity read
                                     ▼
                    ┌─────────────────────────────────────┐
                    │  Azure Key Vault                     │
                    │  ─ forge-api-key                     │
                    │  ─ forge-game-slugs                  │
                    │  ─ allowed-emails                    │
                    └─────────────────────────────────────┘
```

### Where the Forge API key lives

- **Stored:** Azure Key Vault secret `forge-api-key`
- **Read by:** Function App's system-assigned managed identity (Key Vault
  Secrets User role)
- **Never appears in:** source code, GitHub Actions logs, SWA app settings,
  the browser, or anywhere a non-admin user could see it

The Function App configures `FORGE_API_KEY` as a Key Vault reference
(`@Microsoft.KeyVault(VaultName=...;SecretName=forge-api-key)`), which Azure
resolves at process start. The key only exists in Function memory.

---

## One-time setup

You only do this once per environment. After this, `git push` deploys
updates automatically.

### 0. Prerequisites

- Azure CLI installed (`az --version`)
- Logged in: `az login`
- An Azure subscription named **TheForgeControlPanel** (create via Azure portal →
  Subscriptions → Add, under your existing billing account)
- Your Forge API key with `manage-games` permission (see Forge docs;
  generate via the dev-console method described in the
  [Forge API guide](https://forums.forge-vtt.com/t/5982))

### 1. (No app registration needed)

This project uses SWA's **pre-configured Microsoft identity provider**, which
relies on a Microsoft-managed app registration scoped to your Static Web App.
You don't register or maintain anything in Entra — no client ID, no client
secret, no expiry to track. Tenant restriction (so only users from your tenant
can sign in) is enforced server-side by the Function instead, via the
`REQUIRED_TENANT_ID` setting.

### 2. Gather a few values

```powershell
az account set --subscription "TheForgeControlPanel"

# Your tenant ID (you'll need this for the parameter file and GitHub repo variable)
az account show --query tenantId -o tsv

# Your object ID (used for Key Vault admin access)
az ad signed-in-user show --query id -o tsv
```

### 3. Fill in deployment parameters

```bash
cp infra/main.bicepparam.example infra/main.bicepparam
# Edit infra/main.bicepparam:
#   aadTenantId            = your Entra tenant ID from step 2
#   forgeApiKey            = your Forge API key
#   forgeGameSlugsJson     = ["slug-one","slug-two"]
#   allowedEmailsJson      = ["you@example.com","guest@example.com"]
#   keyVaultAdminPrincipalId = your object ID from step 2
```

> `main.bicepparam` is in `.gitignore`. It contains the Forge key — never
> commit it. Bicep marks `forgeApiKey` as `@secure()`, so it won't appear in
> deployment outputs or logs either.

### 4. Deploy infrastructure

```powershell
.\scripts\deploy-infra.ps1 -ResourceGroup RG_TheForgeControlPanel -Location eastus2
```

This creates all Azure resources and configures them. Takes ~3–5 minutes.
Note the `staticWebAppHostname` and `staticWebAppName` outputs.

### 5. (No redirect URI to configure — Microsoft-managed app handles this)

### 6. Bootstrap GitHub repo and push

The `bootstrap-github.ps1` script creates the GitHub repo, reads the SWA
deployment token from Azure, configures the repo secret and variable, and
pushes your initial commit:

```powershell
.\scripts\bootstrap-github.ps1 `
    -GitHubOwner TheWingedLancer `
    -RepoName TheForgeControlPanel `
    -ResourceGroup RG_TheForgeControlPanel `
    -StaticWebAppName <swa-name-from-bicep-output> `
    -AadTenantId ec43f631-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

It's idempotent — safe to re-run if anything goes wrong partway. After it
pushes, GitHub Actions runs the deploy workflow. Watch it with:

```powershell
gh run watch --repo TheWingedLancer/TheForgeControlPanel
```

Within ~2 minutes, the site is live at `https://<your-swa-hostname>`.

### 7. Day 2 — ongoing changes

After the bootstrap, every push to `main` triggers an automatic deploy:

```bash
git add .
git commit -m "..."
git push
```

Pull requests get preview deployments (and are torn down when closed).
`workflow_dispatch` lets you trigger manual deploys from the Actions tab.

---

## Day-to-day operations

### Add or remove allowed users

The `allowed-emails` Key Vault secret is a JSON array. Update it via portal
or CLI; the Function reads it at runtime, no redeploy needed.

```powershell
$emails = '["you@example.com","newguest@example.com"]'
az keyvault secret set `
    --vault-name <kv-name> `
    --name allowed-emails `
    --value $emails
```

> The Function caches Key Vault references for ~24 hours by default. To
> force an immediate refresh, restart the Function App:
> `az functionapp restart -n <func-name> -g RG_TheForgeControlPanel`

### Change the game slugs

Same pattern with the `forge-game-slugs` secret.

### Rotate the Forge API key

1. Generate a new key on the Forge (see Forge docs)
2. Update the `forge-api-key` secret in Key Vault
3. Restart the Function App
4. Optionally revoke the old key on the Forge

### Local development

```bash
# Terminal 1: API
cd api
cp local.settings.json.example local.settings.json   # fill in your dev key
npm install
npm start    # requires Azure Functions Core Tools

# Terminal 2: SWA emulator + frontend
cd frontend
npm install
npm run build
swa start dist --api-location ../api    # requires SWA CLI
```

The SWA CLI gives you a working `/.auth/me` mock so you can test auth flows
locally.

---

## Security notes

- **No Forge key in browser.** Verified: only the Function App can read it.
- **No Forge key in source.** Verified: it lives only in Key Vault.
- **No Forge key in GitHub Actions.** Verified: the workflow only knows the
  SWA deployment token, which controls *deploying code*, not reading
  secrets.
- **Tenant-locked auth.** The app registration uses `AzureADMyOrg` audience,
  so only accounts in your tenant can even reach the sign-in page.
- **Email allowlist on top of tenant auth.** Even within your tenant, only
  emails in `allowed-emails` can call the API.
- **Slug allowlist.** Even an allowed user can only target games whose slugs
  are in `forge-game-slugs` — they can't pass an arbitrary slug.
- **Function locked to SWA.** The linked-backend wiring means the Function
  expects to be called through the SWA, which is what injects the
  authenticated principal. Direct Function URL calls have no principal and
  are rejected.

## Repo layout

```
TheForgeControlPanel/
├── frontend/              # React + Vite UI
│   ├── src/
│   │   ├── App.jsx        # Control panel component
│   │   ├── main.jsx
│   │   └── styles.css     # WFRP-flavored dark theme
│   ├── public/
│   │   └── staticwebapp.config.json  # SWA auth + route gates
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── api/                   # Azure Functions (Node 20, v4 model)
│   ├── src/
│   │   ├── auth.js        # Principal validation + allowlist
│   │   ├── forge.js       # The Forge API client
│   │   └── functions/
│   │       ├── games.js   # GET /api/games
│   │       ├── control.js # POST /api/control/{action}
│   │       └── me.js      # GET /api/me
│   ├── host.json
│   ├── package.json
│   └── local.settings.json.example
├── infra/
│   ├── main.bicep                 # Full Azure resource graph
│   └── main.bicepparam.example    # Copy to main.bicepparam (gitignored)
├── scripts/
│   └── deploy-infra.ps1
├── .github/workflows/
│   └── deploy.yml         # GitHub Actions deployment
├── .gitignore
└── README.md
```
