"""Desktop entry point and compatibility imports for existing tooling.

New code should import the responsible pslounge module directly.
"""

from importlib import import_module
from pslounge.desktop import main

_COMPAT_MODULES = [
    "constants",
    "formatting",
    "licensing",
    "report_data",
    "excel",
    "workbooks",
    "paths",
    "desktop",
    "state",
    "web",
]


def __getattr__(name):
    for module_name in _COMPAT_MODULES:
        module = import_module(f"pslounge.{module_name}")
        if hasattr(module, name):
            return getattr(module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


if __name__ == "__main__":
    main()
