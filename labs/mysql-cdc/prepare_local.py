"""Create ignored local-only credentials before Compose parses the overlay."""
from pathlib import Path
import os
import secrets


def create_secret_file(path: Path, contents: str) -> bool:
    """Create a new local secret file with restrictive permissions from its first inode."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False

    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as secret_file:
            secret_file.write(contents)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return True


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    path = root / ".local/mysql-cdc.env"
    create_secret_file(path, "MYSQL_CDC_ROOT_PASSWORD=" + secrets.token_hex(24) + "\n")
    print("ignored local MySQL credential ready")


if __name__ == "__main__":
    main()
