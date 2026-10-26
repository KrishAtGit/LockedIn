variable "subscription_id" {
  description = "Azure subscription to deploy into (az account show --query id -o tsv)."
  type        = string
}

variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "lockedin"
}

variable "location" {
  description = "Azure region. Australia East is closest to the people using it."
  type        = string
  default     = "australiaeast"
}

variable "image" {
  description = "API image for the first deploy. After that, GitHub Actions rolls out each new image."
  type        = string
  default     = "ghcr.io/krishatgit/lockedin-api:latest"
}

variable "github_repo" {
  description = <<-EOT
    The repo allowed to deploy from its main branch, as GitHub names it in its OIDC tokens: owner@id/repo@id.
    The IDs never change, so a renamed or re-created repo with the same name can't deploy here.
  EOT
  type        = string
  default     = "KrishAtGit@193048311/LockedIn@1420275642"
}

variable "alert_email" {
  description = "Where budget alerts go. Leave empty to skip the budget."
  type        = string
  default     = ""
}

variable "monthly_budget" {
  description = "Monthly spend (USD) that triggers alerts at 50%, 90% and a forecast of 100%."
  type        = number
  default     = 10
}
