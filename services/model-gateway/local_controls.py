"""Safe first-time controls configuration creation."""
import os

def initialize_controls(path, example):
    """Create once without replacing operator settings or following an existing symlink."""
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(descriptor, 'w') as output:
        output.write(example)
    return True
