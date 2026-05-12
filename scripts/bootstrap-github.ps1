# Bootstrap the GitHub repo for TheForgeControlPanel.
#
# Prerequisites (verified at the top of this script):
#   - git installed and configured (user.name, user.email)
#   - gh CLI installed and authenticated (`gh auth status`)
#   - az CLI installed, logged in, subscription set to TheForgeControlPanel
#   - Azure infrastructure already deployed (run scripts/deploy-infra.ps1 first)
#
# What this script does:
#   1. Initializes a local git repo (if not already)
#   2. Creates a PRIVATE GitHub repo under the specified owner
#   3. Reads the SWA deployment token from Azure
#   4. Sets repo secret AZURE_STATIC_WEB_APPS_API_TOKEN
#   5. Sets repo variable AAD_TENANT_ID
#   6. Commits everything in the working tree
#   7. Pushes to main, which triggers the deploy workflow
#
# Idempotent: safe to re-run. If the repo already exists, secrets/variables
# already set, or there's nothing new to commit, the script reports the
# state and moves on rather than failing.
#
# Usage (from repo root):
#   .\scripts\bootstrap-github.ps1 `
#       -GitHubOwner TheWingedLancer `
#       -RepoName TheForgeControlPanel `
#       -ResourceGroup RG_TheForgeControlPanel `
#       -StaticWebAppName <swa-name-from-bicep-output> `
#       -AadTenantId ec43f631-xxxx-xxxx-xxxx-xxxxxxxxxxxx

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GitHubOwner,

    [Parameter(Mandatory = $true)]
    [string]$RepoName,

    [Parameter(Mandatory = $true)]
    [string]$ResourceGroup,

    [Parameter(Mandatory = $true)]
    [string]$StaticWebAppName,

    [Parameter(Mandatory = $true)]
    [string]$AadTenantId,

    [string]$DefaultBranch = "main",

    [string]$CommitMessage = "Initial commit: TheForgeControlPanel scaffold"
)

$ErrorActionPreference = "Stop"

# Use these to print colored, structured output without polluting non-terminal hosts
function Write-Step($msg)    { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)      { Write-Host "    $msg" -ForegroundColor Green }
function Write-Info($msg)    { Write-Host "    $msg" -ForegroundColor Gray }
function Write-WarnLine($msg){ Write-Host "    $msg" -ForegroundColor Yellow }

# ===================================================================
# 0. Preflight: verify all the tools are present and logged in
# ===================================================================
Write-Step "Preflight checks"

foreach ($tool in @("git", "gh", "az")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Error "$tool is not installed or not on PATH."
        exit 1
    }
}
Write-OK "git, gh, az all on PATH"

# gh auth
$ghStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "GitHub CLI not authenticated. Run: gh auth login"
    exit 1
}
Write-OK "gh authenticated"

# az auth & subscription
$account = az account show --output json 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Error "Azure CLI not logged in. Run: az login"
    exit 1
}
if ($account.name -ne "TheForgeControl") {
    Write-WarnLine "Current subscription is '$($account.name)'. Switching to TheForgeControlPanel..."
    az account set --subscription "TheForgeControl"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Could not switch to subscription 'TheForgeControlPanel'. Check the name and your access."
        exit 1
    }
}
Write-OK "az subscription: TheForgeControlPanel"

# git identity
$gitUser  = git config --get user.name  2>$null
$gitEmail = git config --get user.email 2>$null
if (-not $gitUser -or -not $gitEmail) {
    Write-Error "git user.name and user.email must be configured. Run: git config --global user.name '...' ; git config --global user.email '...'"
    exit 1
}
Write-OK "git identity: $gitUser <$gitEmail>"

# ===================================================================
# 1. Verify we're in the repo root (look for telltale files)
# ===================================================================
Write-Step "Verifying we're in the repo root"
foreach ($f in @("frontend/package.json", "api/package.json", "infra/main.bicep")) {
    if (-not (Test-Path $f)) {
        Write-Error "Expected file '$f' not found. Run this script from the repo root."
        exit 1
    }
}
Write-OK "repo layout looks right"

# ===================================================================
# 2. Initialize git repo if needed
# ===================================================================
Write-Step "Initializing local git repo"
if (-not (Test-Path ".git")) {
    git init --initial-branch=$DefaultBranch | Out-Null
    Write-OK "git repo initialized on branch $DefaultBranch"
} else {
    Write-Info "git repo already initialized"
    # Make sure we're on the right branch name
    $currentBranch = git rev-parse --abbrev-ref HEAD 2>$null
    if ($currentBranch -eq "HEAD") {
        # Empty repo with no commits yet — rename the unborn branch
        git symbolic-ref HEAD "refs/heads/$DefaultBranch"
    } elseif ($currentBranch -ne $DefaultBranch) {
        Write-WarnLine "current branch is '$currentBranch', expected '$DefaultBranch'. Renaming..."
        git branch -M $DefaultBranch
    }
}

# ===================================================================
# 3. Create the GitHub repo (private) if it doesn't exist yet
# ===================================================================
Write-Step "Ensuring GitHub repo $GitHubOwner/$RepoName exists"
$fullName = "$GitHubOwner/$RepoName"
$existing = gh repo view $fullName --json name 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Info "repo $fullName already exists; leaving it alone"
} else {
    Write-Info "creating private repo $fullName"
    # --source=. with --push would commit too — we want to control the commit
    # explicitly below so we can show what we're pushing.
    gh repo create $fullName `
        --private `
        --description "FoundryVTT game control panel hosted on Azure Static Web Apps" `
        --disable-wiki `
        | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to create GitHub repo"
        exit 1
    }
    Write-OK "created $fullName (private)"
}

# Ensure the 'origin' remote points to this repo
$existingOrigin = git remote get-url origin 2>$null
$expectedOrigin = "https://github.com/$fullName.git"
if (-not $existingOrigin) {
    git remote add origin $expectedOrigin
    Write-OK "added remote origin → $expectedOrigin"
} elseif ($existingOrigin -ne $expectedOrigin -and $existingOrigin -ne "git@github.com:$fullName.git") {
    Write-WarnLine "remote origin is '$existingOrigin'; updating to '$expectedOrigin'"
    git remote set-url origin $expectedOrigin
} else {
    Write-Info "remote origin already correct"
}

# ===================================================================
# 4. Pull the SWA deployment token from Azure
# ===================================================================
Write-Step "Reading SWA deployment token from Azure"
$swaToken = az staticwebapp secrets list `
    --name $StaticWebAppName `
    --resource-group $ResourceGroup `
    --query "properties.apiKey" `
    --output tsv 2>$null

if (-not $swaToken -or $LASTEXITCODE -ne 0) {
    Write-Error "Could not read the SWA deployment token. Verify the Static Web App '$StaticWebAppName' exists in resource group '$ResourceGroup' and that you have access."
    exit 1
}
Write-OK "got SWA deployment token ($(($swaToken).Length) chars)"

# ===================================================================
# 5. Configure GitHub secrets and variables
# ===================================================================
Write-Step "Configuring repo secret AZURE_STATIC_WEB_APPS_API_TOKEN"
# `gh secret set` reads from stdin when --body is omitted, which avoids the
# secret showing up in a process command line (and PowerShell history).
$swaToken | gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN --repo $fullName
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to set repo secret"
    exit 1
}
Write-OK "secret set"

Write-Step "Configuring repo variable AAD_TENANT_ID"
gh variable set AAD_TENANT_ID --body $AadTenantId --repo $fullName | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to set repo variable"
    exit 1
}
Write-OK "variable set"

# ===================================================================
# 6. Verify .gitignore covers the secret files
# ===================================================================
Write-Step "Sanity-checking .gitignore"
$gitignore = if (Test-Path ".gitignore") { Get-Content .gitignore -Raw } else { "" }
$mustIgnore = @(
    "main.bicepparam",
    "local.settings.json",
    "node_modules"
)
$missing = $mustIgnore | Where-Object { $gitignore -notmatch [regex]::Escape($_) }
if ($missing.Count -gt 0) {
    Write-Error "These patterns are not in .gitignore: $($missing -join ', '). Refusing to commit until they are — secret files could be exposed."
    exit 1
}
Write-OK ".gitignore covers all secret files"

# Belt-and-suspenders: check that the parameter file isn't tracked already
$trackedSecrets = git ls-files 2>$null | Where-Object {
    $_ -match "main\.bicepparam$" -or $_ -match "local\.settings\.json$"
}
if ($trackedSecrets) {
    Write-Error "These files are tracked but contain secrets: $($trackedSecrets -join ', '). Remove them before pushing: git rm --cached <file>"
    exit 1
}

# ===================================================================
# 7. Stage, commit, push
# ===================================================================
Write-Step "Staging and committing"
git add .

$staged = git diff --cached --name-only
if (-not $staged) {
    Write-Info "nothing to commit; working tree matches HEAD"
} else {
    Write-Info "staged $(($staged | Measure-Object).Count) files"
    git commit -m $CommitMessage | Out-Null
    Write-OK "committed"
}

Write-Step "Pushing to origin/$DefaultBranch"

# Detect whether the remote has any existing commits on the target branch.
# An empty remote returns nothing; a populated one returns one or more lines.
$remoteRefs = git ls-remote --heads origin $DefaultBranch 2>$null
if ($remoteRefs) {
    Write-WarnLine "Remote branch '$DefaultBranch' already has commits."
    Write-WarnLine "Attempting a normal push first; if it fails, you may need to rebase."
}

git push -u origin $DefaultBranch
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Push was rejected. This usually means the remote has commits the local repo doesn't have" -ForegroundColor Red
    Write-Host "(e.g. the GitHub repo was created with an auto-generated README or .gitignore)." -ForegroundColor Red
    Write-Host ""
    Write-Host "Fix it with one of:" -ForegroundColor Yellow
    Write-Host "  Option A (preserve remote commits):"
    Write-Host "    git pull --rebase origin $DefaultBranch"
    Write-Host "    git push -u origin $DefaultBranch"
    Write-Host ""
    Write-Host "  Option B (replace remote with local — only if remote has nothing you want):"
    Write-Host "    git push -u --force origin $DefaultBranch"
    exit 1
}
Write-OK "pushed"

# ===================================================================
# 8. Report what happens next
# ===================================================================
Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ""
Write-Host "GitHub Actions should now be running. Watch it with:" -ForegroundColor Yellow
Write-Host "  gh run watch --repo $fullName"
Write-Host ""
Write-Host "Or open in the browser:" -ForegroundColor Yellow
Write-Host "  gh repo view $fullName --web"
Write-Host ""
Write-Host "After it succeeds, the SWA hostname (from the Bicep output) is your URL." -ForegroundColor Yellow
