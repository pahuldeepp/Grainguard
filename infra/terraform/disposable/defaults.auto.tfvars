# Every image in this environment is disposable. Make destroy remove
# repositories even when release images are still present.
delete_nonempty_ecr_on_destroy     = true
enable_disposable_destroy_sentinel = true

# The user selected the existing GreenGuard Dex/OIDC architecture. In the
# disposable AWS cell, provision that same OIDC provider as managed Dex.
identity_mode           = "managed-dex"
enable_application_tree = true

# Shortest waiting period AWS allows before the EKS secrets key is deleted.
kms_deletion_window_days = 7
