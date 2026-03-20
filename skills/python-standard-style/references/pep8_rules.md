# Detailed PEP 8 Rules & Examples

## Naming Conventions

| Type | Convention | Example |
| :--- | :--- | :--- |
| **Class** | PascalCase | `class MarketSignalEngine:` |
| **Function** | snake_case | `def build_signals():` |
| **Variable** | snake_case | `target_exposure = 0.2` |
| **Constant** | UPPER_SNAKE | `MAX_CAPITAL = 20.0` |
| **Method** | snake_case | `def execute_intent(self):` |
| **Module** | snake_case | `import market_data` |

## Indentation & Layout

### 4-Space Rule
Always use 4 spaces. Configure your editor to insert spaces instead of tabs.

### Line Continuation
Prefer using Python's implicit line joining inside parentheses, brackets, and braces.

```python
# Recommended
def long_function_name(
    var_one, var_two, var_three,
    var_four
):
    print(var_one)
```

### Imports
Group imports in the following order, with a blank line between each group:
1. Standard library imports.
2. Related third-party imports.
3. Local application/library specific imports.

```python
import os
import sys

import pandas as pd
from alpaca.trading.client import TradingClient

from valuesteward.config import get_settings
```

## Documentation (Docstrings)

Use `"""Triple Double Quotes"""` for all public modules, functions, classes, and methods.

```python
def sync_intent(intent_dict: dict):
    """Upsert a single intent into the relational database."""
    # implementation
```

## Comparisons

- Use `is` or `is not` when comparing to singletons like `None`.
- Do not use `==` for `True` or `False` (e.g., `if x:` instead of `if x == True:`).
