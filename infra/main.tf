# LockedIn API on Azure: a Container App (scales to zero when idle) in front of a small Postgres server.
# AI runs on Ollama, which needs more memory than a cheap container has, so the hosted API answers with
# its built-in rules and cache, and people who want AI point the extension at their own Ollama-backed server.

resource "azurerm_resource_group" "main" {
  name     = "${var.name}-rg"
  location = var.location
}

# Server names are global across Azure, so they get a short random suffix.
resource "random_string" "suffix" {
  length  = 5
  special = false
  upper   = false
}

# Letters and digits only, so it can go straight into the connection URL.
resource "random_password" "db" {
  length  = 32
  special = false
}

# ---- Database ----

resource "azurerm_postgresql_flexible_server" "db" {
  name                = "${var.name}-db-${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  version             = "16"
  # The smallest burstable size: plenty for a cache of page verdicts.
  sku_name                      = "B_Standard_B1ms"
  storage_mb                    = 32768
  backup_retention_days         = 7
  administrator_login           = "lockedin"
  administrator_password        = random_password.db.result
  public_network_access_enabled = true

  lifecycle {
    # Azure picks the zone; don't fight it on later applies.
    ignore_changes = [zone]
  }
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  name      = "lockedin"
  server_id = azurerm_postgresql_flexible_server.db.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# 0.0.0.0 is Azure's shorthand for "other Azure services", which is where the Container App connects from.
# Connections are encrypted (ssl=require below) and need the generated password.
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  name             = "allow-azure-services"
  server_id        = azurerm_postgresql_flexible_server.db.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

# ---- API ----

resource "azurerm_log_analytics_workspace" "logs" {
  name                = "${var.name}-logs"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_container_app_environment" "main" {
  name                       = "${var.name}-env"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.logs.id

  # Azure now creates every environment with this pay-per-use profile, so declare it rather than fight it.
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

locals {
  database_url = format(
    "postgresql+asyncpg://%s:%s@%s:5432/%s?ssl=require",
    azurerm_postgresql_flexible_server.db.administrator_login,
    random_password.db.result,
    azurerm_postgresql_flexible_server.db.fqdn,
    azurerm_postgresql_flexible_server_database.app.name,
  )
}

resource "azurerm_container_app" "api" {
  name                         = "${var.name}-api"
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  secret {
    name  = "database-url"
    value = local.database_url
  }

  ingress {
    external_enabled = true
    target_port      = 8000
    transport        = "http"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    # Zero replicas while idle, so it costs nothing when nobody is browsing.
    min_replicas = 0
    max_replicas = 2

    container {
      name   = "api"
      image  = var.image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name        = "LOCKEDIN_DATABASE_URL"
        secret_name = "database-url"
      }
      env {
        name  = "LOCKEDIN_AI_ENABLED"
        value = "false"
      }
    }

    http_scale_rule {
      name                = "http"
      concurrent_requests = "50"
    }
  }

  lifecycle {
    # GitHub Actions deploys each new image; Terraform owns everything else.
    ignore_changes = [template[0].container[0].image]
  }
}

# ---- Budget ----

data "azurerm_subscription" "current" {}

resource "azurerm_consumption_budget_subscription" "monthly" {
  count           = var.alert_email == "" ? 0 : 1
  name            = "${var.name}-monthly"
  subscription_id = data.azurerm_subscription.current.id
  amount          = var.monthly_budget
  time_grain      = "Monthly"

  time_period {
    start_date = formatdate("YYYY-MM-01'T'00:00:00Z", timestamp())
  }

  notification {
    threshold      = 50
    operator       = "GreaterThan"
    threshold_type = "Actual"
    contact_emails = [var.alert_email]
  }
  notification {
    threshold      = 90
    operator       = "GreaterThan"
    threshold_type = "Actual"
    contact_emails = [var.alert_email]
  }
  notification {
    threshold      = 100
    operator       = "GreaterThan"
    threshold_type = "Forecasted"
    contact_emails = [var.alert_email]
  }

  lifecycle {
    # The start date only matters when the budget is created.
    ignore_changes = [time_period]
  }
}
