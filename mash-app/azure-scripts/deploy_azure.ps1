# Azure Deployment Script for IMU Connect
# Run this in PowerShell after logging in via `az login`

$ResourceGroup = "rg-imu-connect-dev"
$Location = "eastus"
$SqlServer = "sql-imu-connect-$((Get-Random))"
$SqlDb = "sqldb-imu-connect"
$StorageAccount = "stimustorage$((Get-Random))"
$StaticUpdate = "stapp-imu-connect"

Write-Host "Creating Resource Group..."
az group create --name $ResourceGroup --location $Location

Write-Host "Creating Storage Account..."
az storage account create --name $StorageAccount --resource-group $ResourceGroup --location $Location --sku Standard_LRS

Write-Host "Creating SQL Server (Admin: imuadmin)..."
$SqlAdminPass = Read-Host -Prompt "Enter Password for SQL Admin (imuadmin)" -AsSecureString
$SqlAdminPassPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SqlAdminPass))

az sql server create --name $SqlServer --resource-group $ResourceGroup --location $Location --admin-user imuadmin --admin-password $SqlAdminPassPlain

Write-Host "Creating SQL Database..."
az sql db create --resource-group $ResourceGroup --server $SqlServer --name $SqlDb --service-objective Basic

Write-Host "Allowing Azure Services to access SQL..."
az sql server firewall-rule create --resource-group $ResourceGroup --server $SqlServer --name AllowAzure --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0

Write-Host "Getting Connection String..."
$ConnString = az sql db show-connection-string --client ado.net --name $SqlDb --server $SqlServer --output tsv
$ConnString = $ConnString.Replace("<username>", "imuadmin").Replace("<password>", $SqlAdminPassPlain)


Write-Host "Creating Static Web App..."
$RepoUrl = Read-Host -Prompt "Enter your GitHub Repository URL (e.g., https://github.com/danst/imu-connect)"
$Branch = "main"

# Create SWA
az staticwebapp create --name $StaticUpdate --resource-group $ResourceGroup --location $Location --source $RepoUrl --branch $Branch --login-with-github

Write-Host "Retrieving Deployment Token..."
$DeploymentToken = az staticwebapp secrets list --name $StaticUpdate --resource-group $ResourceGroup --query "properties.apiKey" --output tsv

Write-Host "---------------------------------------------------"
Write-Host "DEPLOYMENT COMPLETE"
Write-Host "---------------------------------------------------"
Write-Host "1. SQL Connection String (add to API Application Settings):"
Write-Host $ConnString
Write-Host ""
Write-Host "2. Deployment Token (add to GitHub Secrets as AZURE_STATIC_WEB_APPS_API_TOKEN):"
Write-Host $DeploymentToken
Write-Host "---------------------------------------------------"
