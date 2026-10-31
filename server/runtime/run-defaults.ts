// Resolve saved host choices per role without inheriting incompatible options after a caller changes the model.
import type { RoleProviderSelection, RoleProviderSelections } from "../../shared/settings";

export function roleRunDefaults(
  saved: RoleProviderSelection, provider?: string, thinkingOptionId?: string, permissionModeId?: string,
) {
  const sameModel = !provider || provider === saved.providerModel;
  const sameProvider = !provider || provider.split("/", 1)[0] === saved.providerModel?.split("/", 1)[0];
  // A CLI override behaves like the model picker: thinking resets per model and permissions reset per provider.
  return { provider: provider ?? saved.providerModel ?? undefined,
    thinkingOptionId: thinkingOptionId ?? (sameModel ? saved.thinkingOptionId : null),
    permissionModeId: permissionModeId ?? (sameProvider ? saved.permissionModeId : null) };
}

// Settings saved before the Product Agent had its own entry hold no model for it, so it keeps borrowing the Supervisor's
// until the user picks one; otherwise an upgrade would silently move it onto whatever the catalog lists first.
export function productAgentDefaults(roles: RoleProviderSelections) {
  return roleRunDefaults(roles.product.providerModel ? roles.product : roles.supervisor);
}
