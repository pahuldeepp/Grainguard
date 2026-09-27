# Every image in this environment is disposable. Make destroy remove
# repositories even when release images are still present.
delete_nonempty_ecr_on_destroy = true

# Shortest waiting period AWS allows before the EKS secrets key is deleted.
kms_deletion_window_days = 7
