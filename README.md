# TheForgeControlPanel

A private Azure Static Web App for starting, stopping, and idling FoundryVTT
games hosted on [The Forge](https://forge-vtt.com), gated behind Entra ID
authentication with per-user access control.

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │  Browser (you + assigned guests)     │
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
                    │  Azure Function App (Flex)           │
                    │  ─ Validates SWA principal           │
                    │  ─ Reads FORGE_API_KEY at runtime    │
                    │  ─ Calls forge-vtt.com/api/game/*    │
                    └────────────────┬─────────────────────┘
                                     │  managed-identity read
                                     ▼
                    ┌─────────────────────────────────────┐
                    │  Azure Key Vault                     │
                    │  ─ forge-api-key                     │
                    │  ─ forge-game-slugs                  │
                    │  ─ aad-client-secret                 │
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

### Access control

Two layers, both managed in Entra ID:

1. **Tenant restriction** via the app registration's `signInAudience =
   AzureADMyOrg`. Only accounts in your Entra tenant (including invited
   guests) can complete sign-in.
2. **Per-user assignment** via the Enterprise Application's `Users and
   groups` blade. Even within your tenant, only users explicitly assigned
   to the app can sign in. Manage this from the Azure portal — no code
   changes needed to add/remove users.

### Slug allowlist

Even an authorized user can only target games whose slugs are in the
`forge-game-slugs` Key Vault secret. This prevents pranks like calling
`/api/control/stop` against an arbitrary game.

### Slow-start handling

Forge `start` calls can exceed 30 seconds (a Foundry instance has to boot).
Azure Static Web Apps enforces a ~30s timeout on linked-backend calls. The
Function races the Forge response against a 25-second timer; if Forge is
still working, the Function returns HTTP 202 with `{ pending: true }` and
the Forge call continues in the background. The frontend shows a "still
working" message; refreshing the game URL after ~30 more seconds confirms
the boot completed.

---

## One-time setup

### 0. Prerequisites

- Azure CLI installed (`az --version`)
- GitHub CLI installed (`gh --version`) and authenticated (`gh auth login`)
- Azure CLI logged in (`az login`)
- A dedicated Azure subscription (e.g. `TheForgeControl`)
- A Forge API key with `manage-games` permission (generated via the dev
  console method in the
  [Forge API guide](https://forums.forge-vtt.com/t/5982))

### 1. Capture identity info

```powershell
az account set --subscription "TheForgeControl"
az account show --query tenantId -o tsv          # save as AAD tenant ID
az ad signed-in-user show --query id -o tsv      # save as your object ID
```

### 2. Create the Entra app registration

Your tenant's default app management policy likely blocks password
credentials, so create a custom exemption policy and assign it to just
this one app, then generate a client secret. After creating the app, also:

- Set the redirect URI: `https://<your-swa-hostname>/.auth/login/aad/callback`
- Enable ID token issuance:
  `web.implicitGrantSettings.enableIdTokenIssuance = true`
- Set `appRoleAssignmentRequired = true` on the Enterprise Application
- Assign yourself to the Enterprise Application

(See conversation history / earlier commits for the exact CLI flow if
re-bootstrapping from scratch.)

### 3. Fill in deployment parameters

```bash
cp infra/main.bicepparam.example infra/main.bicepparam
```

Edit `infra/main.bicepparam` with the values from steps 1-2. The file is
in `.gitignore` and won't be committed.

### 4. Deploy Azure infrastructure

```powershell
.\scripts\deploy-infra.ps1 -ResourceGroup RG_TheForgeControlPanel -Location eastus2
```

Capture the `staticWebAppName` and `staticWebAppHostname` outputs.

### 5. Configure SWA app settings

SWA app settings can't use Key Vault references, so the AAD client ID and
secret are set directly:

```powershell
az staticwebapp appsettings set `
    --name <staticWebAppName from step 4> `
    --resource-group RG_TheForgeControlPanel `
    --setting-names `
      AZURE_CLIENT_ID=<client ID from step 2> `
      AZURE_CLIENT_SECRET=<client secret from step 2>
```

### 6. Bootstrap GitHub repo and trigger first deploy

```powershell
.\scripts\bootstrap-github.ps1 `
    -GitHubOwner <your-github-username> `
    -RepoName TheForgeControlPanel `
    -ResourceGroup RG_TheForgeControlPanel `
    -StaticWebAppName <staticWebAppName from step 4> `
    -AadTenantId <tenantId from step 1>
```

This creates the GitHub repo (if missing), configures the SWA deployment
token and tenant ID variable, commits, and pushes.

### 7. Configure OIDC for Function deploys

GitHub Actions deploys the API to the Function App via OIDC federated
credentials (no long-lived secret). One-time setup creates a user-assigned
managed identity, grants it `Website Contributor` on the Function App, and
trusts your GitHub repo's `main` branch.

Add these as GitHub repository **variables** (not secrets — they're not
sensitive):

- `AZURE_CLIENT_ID` — managed identity client ID
- `AZURE_TENANT_ID` — your Entra tenant ID
- `AZURE_SUBSCRIPTION_ID` — your subscription ID
- `AZURE_FUNCTIONAPP_NAME` — the Function App name (e.g. `func-tfcp-...`)

---

## Day-to-day operations

### Add or remove user access

In the Azure portal: **Microsoft Entra ID → Enterprise applications →
TheForge-Control-Panel → Users and groups**.

- To add an existing tenant user: click `Add user/group`, search, assign.
- To add an external guest: click `Add user/group` → `Users` → `Invite an
  external user`. They get an invitation email; once they accept, assign
  them to the app.
- To remove access: find the user in the list, click `Remove`.

No code changes, no redeploys.

### Change the game slugs

The `forge-game-slugs` Key Vault secret is a JSON array. Update it via
portal or CLI:

```powershell
$slugs = '["age-of-crusades","new-game-slug"]'
az keyvault secret set --vault-name <kv-name> --name forge-game-slugs --value $slugs
```

Restart the Function App to refresh the Key Vault reference cache:

```powershell
az rest --method POST `
    --uri "https://management.azure.com/subscriptions/<sub-id>/resourceGroups/RG_TheForgeControlPanel/providers/Microsoft.Web/sites/<func-name>/restart?api-version=2023-12-01"
```

### Rotate the Forge API key

1. Generate a new key on the Forge (see Forge docs)
2. Update the `forge-api-key` secret in Key Vault
3. Delete and re-add the `FORGE_API_KEY` Function app setting (forces the
   Key Vault reference to re-resolve, working around a Flex Consumption
   caching quirk)
4. Restart the Function App via the management API
5. Optionally revoke the old key on the Forge

### Rotate the AAD client secret

The client secret expires in 2 years (or whatever you configured). When
it's time:

1. Generate a new secret:
   ```powershell
   az ad app credential reset --id <client-id> --years 2
   ```
2. Update the SWA app setting:
   ```powershell
   az staticwebapp appsettings set --name <swa-name> --resource-group RG_TheForgeControlPanel --setting-names AZURE_CLIENT_SECRET=<new secret>
   ```
3. Update the `aad-client-secret` Key Vault secret (for tracking)
4. No restart needed; SWA picks up app setting changes automatically

---

## Local development

```bash
# Terminal 1: API
cd api
cp local.settings.json.example local.settings.json   # fill in dev key
npm install
npm start    # requires Azure Functions Core Tools

# Terminal 2: SWA emulator + frontend
cd frontend
npm install
npm run build
swa start dist --api-location ../api    # requires SWA CLI
```

The SWA CLI provides a mocked `/.auth/me` so you can test auth flows
locally without going through real AAD.

---

## Repo layout

```
TheForgeControlPanel/
├── frontend/              # React + Vite UI
│   ├── src/
│   │   ├── App.jsx        # Control panel component
│   │   ├── main.jsx
│   │   └── styles.css     # WFRP-flavored dark theme
│   ├── scripts/
│   │   └── render-swa-config.mjs  # Renders SWA config from template at build time
│   ├── index.html
│   ├── package.json
│   ├── staticwebapp.config.template.json  # Source for SWA auth + route gates
│   └── vite.config.js
├── api/                   # Azure Functions (Node 20, v4 model, Flex Consumption)
│   ├── src/
│   │   ├── auth.js        # Principal validation
│   │   ├── forge.js       # Forge API client + slow-start handling
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
│   ├── deploy-infra.ps1           # One-shot infra provisioning
│   └── bootstrap-github.ps1       # GitHub repo + secrets setup
├── .github/workflows/
│   └── deploy.yml         # Build, deploy frontend (SWA), deploy API (OIDC)
├── .gitignore
└── README.md
```
