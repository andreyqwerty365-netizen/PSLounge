from __future__ import annotations

from pathlib import Path

import generate_license


def main() -> int:
    source = Path(generate_license.__file__).read_text(encoding="utf-8")
    if 'PRIVATE_D_B64 = "' in source:
        raise AssertionError("private signing exponent must not be embedded in tracked source")

    modulus, private_exponent = generate_license.load_private_key()
    if not modulus or not private_exponent:
        raise AssertionError("local private signing key was not loaded")

    print("[ok] license signing key is loaded outside tracked source")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
