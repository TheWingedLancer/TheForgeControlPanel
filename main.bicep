// =====================================================================
// TheForgeControlPanel - Azure infrastructure
//
// Deploys:
//   - Key Vault (stores Forge API key, game slugs JSON, allowlist JSON)
//   - Storage Account (required by Functions)
//   - App Service Plan (Linux, Flex Consumption)
//   - Function App (linked to SWA, reads secrets via managed identity)
//   - Static Web App (frontend + auth gate)
//   - Linking the SWA to the Function App
//
// The Forge API key NEVER appears in:
//   - Source control
//   - GitHub Actions outputs
//   - SWA configuration
//   - Browser-side code
// It lives in Key Vault and is read at runtime by the Function App's
// system-assigned managed identity via a Key Vault reference.
// =====================================================================

@description('Azure region')
param location string = resourceGroup().location

@description('Random suffix to ensure global uniqueness of certain resources')
param uniqueSuffix string = uniqueString(resourceGroup().id)

@description('Entra ID (Azure AD) tenant ID that users must belong to (enforced server-side by the Function)')
param aadTenantId string

@description('The Forge API key with manage-games permission (provided at deploy time, stored in Key Vault)')
@secure()
param forgeApiKey string

@description('JSON array of Forge game slugs the user wants to control, e.g. ["game-one","game-two"]')
param forgeGameSlugsJson string = '[]'

@description('JSON array of allowed email addresses, e.g. ["you@example.com","guest@example.com"]')
param allowedEmailsJson string

@description('Object ID of the principal that should have admin access to Key Vault (typically your user object id)')
param keyVaultAdminPrincipalId string

// ----------------------------------------------------------------
// Naming
//
// Azure resources have various naming constraints (storage accounts are the
// strictest: <=24 chars, lowercase alphanumeric only). We use a short prefix
// for all generated names to leave room for the uniqueSuffix and stay well
// within every resource's limit. The full project name lives in tags and
// descriptions where humans see it.
// ----------------------------------------------------------------
var shortPrefix = 'tfcp' // TheForgeControlPanel initials
var kvName = 'kv-${shortPrefix}-${uniqueSuffix}'
var stgName = 'st${shortPrefix}${uniqueSuffix}'
var planName = 'plan-${shortPrefix}-${uniqueSuffix}'
var funcName = 'func-${shortPrefix}-${uniqueSuffix}'
var swaName = 'swa-${shortPrefix}-${uniqueSuffix}'

// ----------------------------------------------------------------
// Key Vault
// ----------------------------------------------------------------
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled' // Function reads over public endpoint; restrict via RBAC
  }
}

resource secretForgeKey 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'forge-api-key'
  properties: {
    value: forgeApiKey
    contentType: 'text/plain'
  }
}

resource secretForgeSlugs 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'forge-game-slugs'
  properties: {
    value: forgeGameSlugsJson
    contentType: 'application/json'
  }
}

resource secretAllowedEmails 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'allowed-emails'
  properties: {
    value: allowedEmailsJson
    contentType: 'application/json'
  }
}

// Admin role for the deploying user
resource kvAdminRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, keyVaultAdminPrincipalId, 'kv-admin')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '00482a5a-887f-4fb3-b363-3b7fe8e74483' // Key Vault Administrator
    )
    principalId: keyVaultAdminPrincipalId
    principalType: 'User'
  }
}

// ----------------------------------------------------------------
// Storage account (required by Functions)
//
// Flex Consumption Functions store the deployment package in a blob
// container in this same storage account, accessed via the Function App's
// managed identity. The container must exist before the Function App is
// deployed.
// ----------------------------------------------------------------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: stgName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {}
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'deploymentpackages'
  properties: { publicAccess: 'None' }
}

// ----------------------------------------------------------------
// App Service Plan + Function App (Flex Consumption / FC1)
//
// Flex Consumption is the modern serverless plan for Azure Functions. It uses
// a different quota bucket than classic Consumption (Y1/Dynamic), so a new
// subscription with 0 Dynamic VM quota can still deploy here.
//
// Key differences from Y1:
//   - SKU is FC1 (family 'FC', tier 'FlexConsumption')
//   - Deployment package lives in a blob container (not WEBSITE_RUN_FROM_PACKAGE)
//   - Runtime + scale live in properties.functionAppConfig, not siteConfig
//   - Linux only; reserved=true is implicit but doesn't hurt
// ----------------------------------------------------------------
resource plan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: planName
  location: location
  sku: {
    tier: 'FlexConsumption'
    name: 'FC1'
  }
  kind: 'functionapp'
  properties: {
    reserved: true // Linux-based
  }
}

resource func 'Microsoft.Web/sites@2024-11-01' = {
  name: funcName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deploymentContainer.name}'
          authentication: {
            // The Function App's system-assigned managed identity reads its
            // own deployment package — no storage account key in app settings.
            type: 'SystemAssignedIdentity'
          }
        }
      }
      scaleAndConcurrency: {
        instanceMemoryMB: 2048
        maximumInstanceCount: 40
      }
      runtime: {
        name: 'node'
        version: '20'
      }
    }
    siteConfig: {
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appSettings: [
        {
          name: 'AzureWebJobsStorage__accountName'
          value: storage.name
        }
        // === Key Vault references ===
        // Syntax: @Microsoft.KeyVault(VaultName=...;SecretName=...)
        // Azure resolves this at runtime using the Function's managed identity.
        {
          name: 'FORGE_API_KEY'
          value: '@Microsoft.KeyVault(VaultName=${keyVault.name};SecretName=forge-api-key)'
        }
        {
          name: 'FORGE_GAME_SLUGS'
          value: '@Microsoft.KeyVault(VaultName=${keyVault.name};SecretName=forge-game-slugs)'
        }
        {
          name: 'ALLOWED_EMAILS'
          value: '@Microsoft.KeyVault(VaultName=${keyVault.name};SecretName=allowed-emails)'
        }
        // Plain (non-secret) setting: the tenant ID the Function will accept.
        // Used by the auth helper to reject sign-ins from foreign tenants,
        // since SWA's pre-configured AAD provider is otherwise tenant-agnostic.
        {
          name: 'REQUIRED_TENANT_ID'
          value: aadTenantId
        }
      ]
    }
  }
}

// Flex Consumption uses managed-identity access to its own deployment storage,
// so the Function App needs Storage Blob Data Owner on the storage account.
// (We use Owner rather than Contributor because the Functions runtime needs
// to manage blob metadata for deployment-package management.)
resource funcStorageBlobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, func.id, 'storage-blob-data-owner')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'b7e6dc6d-f1e8-4753-8033-0f276bb0955b' // Storage Blob Data Owner
    )
    principalId: func.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Grant the Function's managed identity "Key Vault Secrets User" so it can
// read (but NOT write or list) secrets at runtime.
resource funcKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, func.id, 'kv-secrets-user')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User
    )
    principalId: func.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ----------------------------------------------------------------
// Static Web App
// ----------------------------------------------------------------
resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: swaName
  location: location
  sku: {
    name: 'Standard' // Standard tier required for "bring your own Functions" linking
    tier: 'Standard'
  }
  properties: {
    // We'll deploy the frontend artifact via GitHub Actions / SWA CLI rather than
    // wiring the SWA directly to a repo here, so no buildProperties block.
  }
}

// SWA auth uses the Microsoft-managed app registration (no client ID/secret
// needed), so the SWA has no auth-related app settings. The tenant ID is
// baked into staticwebapp.config.json at build time via the frontend's
// render-swa-config.mjs script.

// Link the Function App as the SWA's backend. This makes /api/* on the SWA
// proxy to the Function App, and injects x-ms-client-principal on each call.
resource swaBackendLink 'Microsoft.Web/staticSites/linkedBackends@2023-12-01' = {
  parent: swa
  name: 'tfcp-backend'
  properties: {
    backendResourceId: func.id
    region: location
  }
}

// ----------------------------------------------------------------
// Outputs
// ----------------------------------------------------------------
output staticWebAppHostname string = swa.properties.defaultHostname
output staticWebAppName string = swa.name
output functionAppName string = func.name
output keyVaultName string = keyVault.name
output resourceGroupName string = resourceGroup().name
