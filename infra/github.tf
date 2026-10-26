# Lets GitHub Actions deploy without any stored password: Azure trusts GitHub's short-lived OIDC token,
# but only for workflows running on this repo's main branch, and only for this resource group.

data "azuread_client_config" "current" {}

resource "azuread_application" "github" {
  display_name = "${var.name}-github-deploy"
  owners       = [data.azuread_client_config.current.object_id]
}

resource "azuread_service_principal" "github" {
  client_id = azuread_application.github.client_id
  owners    = [data.azuread_client_config.current.object_id]
}

resource "azuread_application_federated_identity_credential" "main_branch" {
  application_id = azuread_application.github.id
  display_name   = "github-main"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = "repo:${var.github_repo}:ref:refs/heads/main"
}

resource "azurerm_role_assignment" "github_deploy" {
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Contributor"
  principal_id         = azuread_service_principal.github.object_id
}
