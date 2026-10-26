output "api_url" {
  description = "Put this in the extension's settings as the server address."
  value       = "https://${azurerm_container_app.api.ingress[0].fqdn}"
}

output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "container_app" {
  value = azurerm_container_app.api.name
}

# Not secrets: they name who may deploy, and only GitHub's signed tokens can use them.
output "github_variables" {
  description = "Repository variables for the deploy workflow."
  value = {
    AZURE_CLIENT_ID       = azuread_application.github.client_id
    AZURE_TENANT_ID       = data.azuread_client_config.current.tenant_id
    AZURE_SUBSCRIPTION_ID = var.subscription_id
  }
}
