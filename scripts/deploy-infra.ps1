# Deploy TheForgeControlPanel infrastructure to Azure.
#
# Prerequisites:
#   - Azure CLI signed in: az login
#   - Subscription selected: az account set --subscription "Brown-Dog-FoundryVTT-Control"
#   - infra/main.bicepparam filled in (copy from main.bicepparam.example)
#
# Usage (from repo root):
#   .\scripts\deploy-infra.ps1 -ResourceGroup RG_TheForgeControlPanel -Location eastus2

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroup,

    [Parameter(Mandatory = $true)]
    [string]$Location,

    [string]$ParamFile = "infra/main.bicepparam",

    [string]$TemplateFile = "infra/main.bicep"
)

$ErrorActionPreference = "Stop"

Write-Host "==> Verifying Azure CLI login" -ForegroundColor Cyan
$account = az account show --output json | ConvertFrom-Json
if (-not $account) {
    Write-Error "Not logged in. Run 'az login' first."
    exit 1
}
Write-Host "    Subscription: $($account.name) ($($account.id))" -ForegroundColor Gray

if (-not (Test-Path $ParamFile)) {
    Write-Error "Parameter file not found: $ParamFile. Copy main.bicepparam.example and fill it in."
    exit 1
}

Write-Host "==> Ensuring resource group $ResourceGroup in $Location" -ForegroundColor Cyan
az group create --name $ResourceGroup --location $Location --output none

Write-Host "==> Deploying Bicep template" -ForegroundColor Cyan
$deployment = az deployment group create `
    --resource-group $ResourceGroup `
    --template-file $TemplateFile `
    --parameters $ParamFile `
    --output json | ConvertFrom-Json

if ($LASTEXITCODE -ne 0) {
    Write-Error "Deployment failed."
    exit 1
}

Write-Host "==> Deployment complete" -ForegroundColor Green
Write-Host ""
Write-Host "Outputs:" -ForegroundColor Yellow
$deployment.properties.outputs.PSObject.Properties | ForEach-Object {
    Write-Host "  $($_.Name) = $($_.Value.value)"
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Open the SWA in the Azure portal, copy the 'Deployment token' from Overview"
Write-Host "  2. Add it as the GitHub repo secret AZURE_STATIC_WEB_APPS_API_TOKEN"
Write-Host "  3. Add the SWA's hostname as a Redirect URI on your Entra app registration:"
Write-Host "       https://<hostname>/.auth/login/aad/callback"
Write-Host "  4. Push to main; GitHub Actions will deploy the frontend + API"
